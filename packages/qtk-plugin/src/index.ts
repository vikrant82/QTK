// QTK — Qalarc Token Killer (also a backronym for "Quantised Token Killer").
//
// Output-side token compression for opencode (and compatible fork) tool calls.
//
// Built downstream of RTK (Rust Token Killer; rtk-ai/rtk) — see
// docs/RTK-COMPARISON.md for the design diff. RTK proved the thesis at
// scale and ships the upstream filter corpus QTK imports from.
//
// Hooks into `tool.execute.after` and rewrites `result.output` in place.
// Read docs/ for the full design.

import type { Plugin } from "@opencode-ai/plugin";
import { resolve } from "node:path";
import { CompressorRegistry } from "./registry.ts";
import { SessionCache } from "./cache.ts";
import { TeeWriter } from "./tee.ts";
import { StatsTracker, commandHead } from "./stats.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { loadConfig } from "./config.ts";
import { estimateTokens } from "./estimator.ts";
import {
  loadFilters,
  loadBundledFilters,
  DEFAULT_FILTER_DIR,
  type LoadResult,
} from "./dsl/loader.ts";
import { watchFilters } from "./dsl/watcher.ts";
import { SidecarClient } from "./sidecar/client.ts";
import { locateQtkCore } from "./sidecar/locator.ts";
import {
  buildSidecarCompressors,
  type AsyncCompressor,
} from "./sidecar/compressors.ts";
import { SavingsExporter } from "./savings-export.ts";
import { extractResultText, type ResultTextTarget } from "./result-text.ts";
import { classifyCompressorSource, isGenericCompressor } from "./metrics.ts";
import { isTruthyEnv, rewriteCommand } from "./rewrite.ts";
import { redactModelText } from "./redaction.ts";
import {
  createQtkLogger,
  formatArrow,
  formatBytes,
  formatRatioSaved,
  sanitizeLogLabel,
  type QtkLogger,
} from "./logger.ts";
import type { CompressionOutcome, QtkConfig } from "./types.ts";

export const QtkPlugin: Plugin = async ({ directory }) => {
  const projectRoot = directory ?? process.cwd();
  if (isTruthyEnv(process.env.QTK_DISABLED)) {
    console.log("[qtk] disabled via QTK_DISABLED");
    return {};
  }

  const config = await loadConfig(projectRoot);
  const logger = createQtkLogger({
    logLevel: config.logLevel,
    debugEnv: process.env.QTK_DEBUG,
  });

  if (!config.enabled) {
    console.log("[qtk] disabled via .opencode/qtk.toml");
    return {};
  }

  const registry = new CompressorRegistry();
  const cache = new SessionCache();
  const breaker = new CircuitBreaker();

  // Load TOML DSL filters. Project-local filters run before bundled filters,
  // and bundled filters run before built-in compressors (first-match wins).
  try {
    let bundledResult: LoadResult = { filters: [], errors: [] };
    let projectResult: LoadResult = { filters: [], errors: [] };

    if (config.filters.bundled) {
      bundledResult = await loadBundledFilters();
    }
    if (config.filters.project) {
      projectResult = await loadFilters(projectRoot, DEFAULT_FILTER_DIR, {
        namespace: "project",
      });
    }

    const disabledFilters = new Set(config.filters.disabled);
    const filters = [...projectResult.filters, ...bundledResult.filters].filter(
      (f) => !disabledFilters.has(f.spec.name) && !disabledFilters.has(f.compressor.name),
    );
    if (filters.length > 0) {
      registry.prepend(filters.map((f) => f.compressor));
      console.log(
        `[qtk] loaded ${filters.length} DSL filter(s): ${filters
          .map((f) => f.spec.name)
          .join(", ")}`,
      );
    }
    for (const e of [...projectResult.errors, ...bundledResult.errors]) {
      console.warn(`[qtk] filter load failed: ${e.source}: ${e.error}`);
    }

    // Hot-reload watcher — picks up new/edited/deleted project filter files
    // without a restart. Bundled filters are static for the session.
    if (config.filters.project) {
      watchFilters(
        projectRoot,
        DEFAULT_FILTER_DIR,
        (result) => {
          const projectFilters = result.filters
            .filter(
              (f) =>
                !disabledFilters.has(f.spec.name) &&
                !disabledFilters.has(f.compressor.name),
            )
            .map((f) => f.compressor);
          const bundledFilters = bundledResult.filters
            .filter(
              (f) =>
                !disabledFilters.has(f.spec.name) &&
                !disabledFilters.has(f.compressor.name),
            )
            .map((f) => f.compressor);
          registry.replaceUserCompressors([
            ...projectFilters,
            ...bundledFilters,
          ]);
          console.log(
            `[qtk] hot-reload: ${result.filters.length} project DSL filter(s) active`,
          );
          for (const e of result.errors) {
            console.warn(`[qtk] filter load failed: ${e.source}: ${e.error}`);
          }
        },
        { namespace: "project" },
      );
    }
  } catch (e) {
    console.warn("[qtk] filter loader failed:", e);
  }

  registry.disable(disabledCompressorNames(config.compressors));
  registry.disable(disabledToolCompressorNames(config.tools));
  if (!config.filters.bundled) registry.removeByPrefix(["dsl:bundled:"]);
  if (!config.filters.project) registry.removeByPrefix(["dsl:project:"]);

  let tee: TeeWriter | null = null;
  if (config.tee.enabled) {
    try {
      tee = new TeeWriter({ projectRoot, teeDir: config.tee.directory });
      // Prune old tee files from prior sessions (best-effort)
      tee.pruneOlderThan(config.tee.pruneDays).then((n) => {
        if (n > 0) console.log(`[qtk] pruned ${n} stale tee files`);
      });
    } catch (e) {
      console.warn("[qtk] tee disabled:", e);
    }
  }

  let stats: StatsTracker | null = null;
  if (config.stats.enabled) {
    stats = new StatsTracker(projectRoot, config.stats.database);
    await stats.init();
  }

  // ─── Savings exporter (cross-tool integration: gmux, dashboards) ─────────
  // Writes <project>/.opencode/qtk-savings.json every 10s (debounced).
  // External consumers (gmux status bar, gmuxtest Tauri UI, phone PWA)
  // read this file to display "QTK saved X tokens ($Y)".
  //
  // Sessions get their id from the first tool.execute.after call's
  // `input.sessionID`. Until that arrives we use a placeholder.
  const savingsExporter = new SavingsExporter(projectRoot, "unknown");

  // ─── Sidecar (Phase 3) — optional Rust binary for heavy parsers ─────────
  let sidecarCompressors: AsyncCompressor[] = [];
  try {
    if (!config.sidecar.enabled) {
      console.log("[qtk] sidecar disabled via .opencode/qtk.toml");
    } else {
      const binPath = await locateQtkCore(projectRoot);
      if (binPath) {
        const client = new SidecarClient({
          binaryPath: binPath,
          requestTimeoutMs: config.sidecar.requestTimeoutMs,
          startupTimeoutMs: config.sidecar.startupTimeoutMs,
          maxRestarts: config.sidecar.maxRestarts,
        });
        // Lazy-start: don't block plugin init waiting for the binary.
        // The first compress() call will await readiness.
        client.start().then(
          () => console.log(`[qtk] sidecar ready (${binPath})`),
          (e) =>
            console.warn(
              `[qtk] sidecar startup failed (${binPath}): ${(e as Error).message}; using TS-only`,
            ),
        );
        sidecarCompressors = buildSidecarCompressors({
          client,
          minInputBytes: config.sidecar.minInputBytes,
        }).filter((c) => !isNameDisabled(c.name, config.sidecar.disabled));
        console.log(
          `[qtk] sidecar enabled — ${sidecarCompressors.length} compressors via qtk-core`,
        );
      } else {
        console.log("[qtk] sidecar: qtk-core binary not found; using TS-only");
      }
    }
  } catch (e) {
    console.warn("[qtk] sidecar setup failed:", e);
  }

  console.log(`[qtk] active — ${registry.size()} compressors registered`);
  console.log(`[qtk] compressors: ${registry.names().join(", ")}`);

  // Best-effort: flush the savings file when the process is about to exit.
  // Bun/Node `beforeExit` is the latest hook that's still inside an async
  // context, so we can await the rename.
  process.on?.("beforeExit", () => {
    void savingsExporter.stop();
  });

  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (
          isTruthyEnv(process.env.QTK_DISABLED) ||
          isTruthyEnv(process.env.QTK_REWRITE_DISABLED) ||
          !config.rewrite.enabled
        ) {
          return;
        }
        if (input.tool.toLowerCase() !== "bash") return;
        if (!isRecord(output.args) || typeof output.args.command !== "string") {
          return;
        }
        const rewritten = rewriteCommand(output.args.command);
        if (!rewritten) return;
        const rewrittenCommand = rewritten.command;
        output.args.command = rewrittenCommand;
        logger.debug("rewrite", {
          tool: input.tool,
          rule: rewritten.rule,
          cmd: safeCommandLabel(rewrittenCommand),
        });
      } catch (e) {
        console.warn("[qtk] tool.execute.before failed:", e);
      }
    },

    "tool.execute.after": async (input, output) => {
      // Defensive: never throw out of this hook.
      try {
        await processCall(input, output, {
          projectRoot,
          registry,
          sidecarCompressors,
          cache,
          breaker,
          tee,
          stats,
          savingsExporter,
          logger,
          dedupTtlMs: config.dedupTtlSeconds * 1000,
          teeMode: config.tee.mode,
          redactionEnabled: config.redaction.enabled,
          config,
        });
      } catch (e) {
        console.warn("[qtk] hook failed (output unchanged):", e);
      }
    },
  };
};

interface ProcessContext {
  projectRoot: string;
  registry: CompressorRegistry;
  sidecarCompressors: readonly AsyncCompressor[];
  cache: SessionCache;
  breaker: CircuitBreaker;
  tee: TeeWriter | null;
  stats: StatsTracker | null;
  savingsExporter: Pick<
    SavingsExporter,
    "record" | "setModelId" | "setSessionId"
  >;
  logger: QtkLogger;
  dedupTtlMs: number;
  teeMode: "always" | "failures_and_compressed" | "never";
  redactionEnabled: boolean;
  config: QtkConfig;
}

interface HookInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: unknown;
}

interface HookOutput {
  output?: string;
  content?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
}

async function processCall(
  input: HookInput,
  output: HookOutput,
  ctx: ProcessContext,
): Promise<void> {
  const target = extractResultText(output);
  if (!target) {
    ctx.logger.debug("passthrough", {
      tool: input.tool,
      reason: "no_text",
    });
    return;
  }
  if (!target.text) {
    ctx.logger.debug("passthrough", {
      tool: input.tool,
      shape: target.shape,
      reason: "empty_text",
    });
    return;
  }
  const raw = target.text;
  if (raw.length < ctx.config.compression.minInputBytes) {
    const redacted = writePassThroughIfRedacted(target, raw, ctx.redactionEnabled);
    if (redacted) {
      logRedacted(ctx.logger, input, {}, target.shape, raw, redacted);
    } else {
      logPassThrough(ctx.logger, input, {}, target.shape, raw, "too_small");
    }
    return; // small outputs are not worth compressing, but may need redaction
  }

  const args = extractHookArgs(input, output);

  // Compute fingerprint and output hash
  const fp = ctx.cache.fingerprint(input.tool, args);
  const outHash = ctx.cache.outputHash(raw);

  // Learn metadata from the hook input/output as it becomes available.
  if (input.sessionID) {
    ctx.savingsExporter.setSessionId(input.sessionID);
    ctx.savingsExporter.setModelId(extractModelId(output));
  }

  // Cache lookup — same call, same output, within TTL?
  const cacheHit = ctx.cache.lookup(fp, outHash, ctx.dedupTtlMs);
  if (cacheHit) {
    const elapsed = Math.round((Date.now() - cacheHit.ts) / 1000);
    const cachedOpen =
      `<qtk-unchanged tool=${input.tool} since=${elapsed}s_ago` +
      (cacheHit.lossy ? ` lossy=true` : "") +
      (cacheHit.teeFile
        ? ` tee=${pathToRelative(cacheHit.teeFile, ctx.projectRoot)}`
        : "") +
      `>`;
    const cachedOutput = `${cachedOpen}\n${cacheHit.compressed}\n</qtk-unchanged>`;
    const modelCachedOutput = writeModelText(
      target,
      cachedOutput,
      ctx.redactionEnabled,
    );
    const cacheOutcome: CompressionOutcome = {
      compressor: "session-cache",
      compressorSource: "session-cache",
      resultShape: target.shape,
      isLossy: cacheHit.lossy ?? false,
      isGeneric: false,
      originalBytes: raw.length,
      compressedBytes: modelCachedOutput.text.length,
      originalTokensEst: estimateTokens(raw),
      compressedTokensEst: estimateTokens(modelCachedOutput.text),
      ratio: modelCachedOutput.text.length / raw.length,
      durationMs: 0,
      wasCacheHit: true,
      teeFile: cacheHit.teeFile ?? null,
    };
    if (ctx.stats) {
      ctx.stats.log({
        sessionID: input.sessionID,
        tool: input.tool,
        commandHead: extractCommandHead(input.tool, args),
        outcome: cacheOutcome,
      });
    }
    ctx.savingsExporter.record(cacheOutcome, {
      tool: input.tool,
      compressorSource: cacheOutcome.compressorSource,
      resultShape: cacheOutcome.resultShape,
    });
    ctx.logger.debug("cache-hit", {
      ...logFields(input, args),
      shape: target.shape,
      bytes: formatArrow(formatBytes(raw.length), formatBytes(modelCachedOutput.text.length)),
      saved: formatRatioSaved(raw.length, modelCachedOutput.text.length),
      tok: formatArrow(estimateTokens(raw), estimateTokens(modelCachedOutput.text)),
      since: `${elapsed}s`,
      lossy: cacheHit.lossy ? true : undefined,
      tee: cacheHit.teeFile ? pathToRelative(cacheHit.teeFile, ctx.projectRoot) : undefined,
      redactions: modelCachedOutput.redactionCount || undefined,
    });
    return;
  }

  // First chance: sidecar (async) compressors. These handle heavy parsers
  // (terraform plan, kubectl YAML/JSON, cargo --message-format=json, JUnit XML).
  // If a sidecar compressor matches but the Rust process isn't ready or
  // returns nothing, it returns `raw` unchanged and we fall through to the
  // regular sync registry.
  let compressed: string | null = null;
  let compressorName = "";
  let durationMs = 0;
  for (const sc of ctx.sidecarCompressors) {
    if (!sc.matches(input.tool, args)) continue;
    if (ctx.breaker.isDisabled(sc.name)) break;
    const t0 = performance.now();
    let candidate: string;
    try {
      candidate = await sc.compress(raw, { args });
    } catch (e) {
      const newlyDisabled = ctx.breaker.recordFailure(sc.name);
      if (newlyDisabled) {
        console.warn(
          `[qtk] disabling sidecar compressor '${sc.name}' after 3 failures`,
        );
      }
      break;
    }
    durationMs = Math.round(performance.now() - t0);
    if (candidate !== raw && candidate.length < raw.length) {
      compressed = candidate;
      compressorName = sc.name;
    }
    break; // first matching sidecar wins (matches sync registry semantics)
  }

  // Fall through to sync registry if sidecar didn't compress
  if (compressed === null) {
    const compressor = ctx.registry.lookup(input.tool, args);
    if (!compressor) {
      // No compressor matched. Still cache (raw stays as-is) so we catch
      // identical repeats next time.
      const redactedRaw = maybeRedactModelText(raw, ctx.redactionEnabled);
      ctx.cache.put(fp, outHash, redactedRaw.text);
      if (redactedRaw.count > 0) {
        target.write(redactedRaw.text);
        logRedacted(ctx.logger, input, args, target.shape, raw, redactedRaw, {
          reason: "no_match",
        });
      } else {
        logPassThrough(ctx.logger, input, args, target.shape, raw, "no_match");
      }
      return;
    }
    if (ctx.breaker.isDisabled(compressor.name)) {
      const redacted = writePassThroughIfRedacted(target, raw, ctx.redactionEnabled);
      if (redacted) {
        logRedacted(ctx.logger, input, args, target.shape, raw, redacted, {
          reason: "compressor_disabled",
          compressor: compressor.name,
        });
      } else {
        logPassThrough(
          ctx.logger,
          input,
          args,
          target.shape,
          raw,
          "compressor_disabled",
          { compressor: compressor.name },
        );
      }
      return; // circuit-broken: pass through
    }

    const t0 = performance.now();
    let candidate: string;
    try {
      candidate = compressor.compress(raw, {
        args,
        cwd: ctx.projectRoot,
        config: configForCompressor(ctx.config, compressor.name),
      });
    } catch (e) {
      const newlyDisabled = ctx.breaker.recordFailure(compressor.name);
      if (newlyDisabled) {
        console.warn(
          `[qtk] disabling compressor '${compressor.name}' after 3 failures`,
        );
      }
      const redacted = writePassThroughIfRedacted(target, raw, ctx.redactionEnabled);
      if (redacted) {
        logRedacted(ctx.logger, input, args, target.shape, raw, redacted, {
          reason: "compressor_error",
          compressor: compressor.name,
        });
      } else {
        logPassThrough(ctx.logger, input, args, target.shape, raw, "compressor_error", {
          compressor: compressor.name,
        });
      }
      return; // output unchanged except possible redaction
    }
    durationMs = Math.round(performance.now() - t0);
    compressed = candidate;
    compressorName = compressor.name;
  }

  // Safety: compressor must produce ≤ input length
  if (compressed.length > raw.length) {
    console.warn(
      `[qtk] compressor '${compressorName}' produced larger output, ignoring`,
    );
    const redacted = writePassThroughIfRedacted(target, raw, ctx.redactionEnabled);
    if (redacted) {
      logRedacted(ctx.logger, input, args, target.shape, raw, redacted, {
        reason: "larger_output",
        compressor: compressorName,
      });
    } else {
      logPassThrough(ctx.logger, input, args, target.shape, raw, "larger_output", {
        compressor: compressorName,
        candidateBytes: compressed.length,
      });
    }
    return;
  }
  // No actual compression
  if (compressed === raw) {
    const redacted = writePassThroughIfRedacted(target, raw, ctx.redactionEnabled);
    if (redacted) {
      logRedacted(ctx.logger, input, args, target.shape, raw, redacted, {
        reason: "unchanged",
        compressor: compressorName,
      });
    } else {
      logPassThrough(ctx.logger, input, args, target.shape, raw, "unchanged", {
        compressor: compressorName,
      });
    }
    return;
  }

  const bodyRatio = compressed.length / raw.length;
  const isLossyGeneric = isGenericCompressor(compressorName);

  // Decide whether to tee
  let teeFile: string | null = null;
  const shouldTee =
    isLossyGeneric ||
    (ctx.tee && ctx.teeMode === "always") ||
    (ctx.teeMode === "failures_and_compressed" && bodyRatio < 0.7);
  if (shouldTee && ctx.tee) {
    teeFile = await ctx.tee.write(input.callID, raw);
  }
  // Generic fallbacks are intentionally lossy summaries. Require a recoverable
  // raw tee so the agent can inspect exact content if needed.
  if (isLossyGeneric && !teeFile) {
    const redacted = writePassThroughIfRedacted(target, raw, ctx.redactionEnabled);
    if (redacted) {
      logRedacted(ctx.logger, input, args, target.shape, raw, redacted, {
        reason: "generic_requires_tee",
        compressor: compressorName,
      });
    } else {
      logPassThrough(
        ctx.logger,
        input,
        args,
        target.shape,
        raw,
        "generic_requires_tee",
        { compressor: compressorName },
      );
    }
    return;
  }

  // Wrap compressed output in an envelope so the model can find the tee if needed
  const origLines = raw.split("\n").length;
  const envelopeOpen =
    `<qtk-compressed compressor=${compressorName} orig_lines=${origLines} ratio=${bodyRatio.toFixed(2)}` +
    (isLossyGeneric ? ` lossy=true` : "") +
    (teeFile ? ` tee=${pathToRelative(teeFile, ctx.projectRoot)}` : "") +
    `>`;

  const compressedOutput = `${envelopeOpen}\n${compressed}\n</qtk-compressed>`;
  const modelCompressedOutput = writeModelText(
    target,
    compressedOutput,
    ctx.redactionEnabled,
  );

  // Cache the (raw) hash + the compressed body, so repeats short-circuit
  ctx.cache.put(fp, outHash, maybeRedactModelText(compressed, ctx.redactionEnabled).text, {
    lossy: isLossyGeneric,
    teeFile,
  });

  // Log to stats + savings export (always — exporter is required)
  const outcome: CompressionOutcome = {
    compressor: compressorName,
    compressorSource: classifyCompressorSource(compressorName),
    resultShape: target.shape,
    isLossy: isLossyGeneric,
    isGeneric: isGenericCompressor(compressorName),
    originalBytes: raw.length,
    compressedBytes: modelCompressedOutput.text.length,
    originalTokensEst: estimateTokens(raw),
    compressedTokensEst: estimateTokens(modelCompressedOutput.text),
    ratio: modelCompressedOutput.text.length / raw.length,
    durationMs,
    wasCacheHit: false,
    teeFile,
  };
  if (ctx.stats) {
    ctx.stats.log({
      sessionID: input.sessionID,
      tool: input.tool,
      commandHead: extractCommandHead(input.tool, args),
      outcome,
    });
  }
  ctx.savingsExporter.record(outcome, {
    tool: input.tool,
    compressorSource: outcome.compressorSource,
    resultShape: outcome.resultShape,
  });
  ctx.logger.debug("compressed", {
    ...logFields(input, args),
    shape: target.shape,
    compressor: compressorName,
    bytes: formatArrow(formatBytes(raw.length), formatBytes(modelCompressedOutput.text.length)),
    saved: formatRatioSaved(raw.length, modelCompressedOutput.text.length),
    tok: formatArrow(estimateTokens(raw), estimateTokens(modelCompressedOutput.text)),
    dt: `${durationMs}ms`,
    lossy: isLossyGeneric ? true : undefined,
    tee: teeFile ? pathToRelative(teeFile, ctx.projectRoot) : undefined,
    redactions: modelCompressedOutput.redactionCount || undefined,
  });
}

interface ModelWriteResult {
  readonly text: string;
  readonly redactionCount: number;
}

function writeModelText(
  target: ResultTextTarget,
  text: string,
  redactionEnabled: boolean,
): ModelWriteResult {
  const redacted = maybeRedactModelText(text, redactionEnabled);
  target.write(redacted.text);
  return { text: redacted.text, redactionCount: redacted.count };
}

function writePassThroughIfRedacted(
  target: ResultTextTarget,
  text: string,
  redactionEnabled: boolean,
): ModelWriteResult | null {
  const redacted = maybeRedactModelText(text, redactionEnabled);
  if (redacted.count === 0) return null;
  target.write(redacted.text);
  return { text: redacted.text, redactionCount: redacted.count };
}

function maybeRedactModelText(
  text: string,
  redactionEnabled: boolean,
): ReturnType<typeof redactModelText> {
  if (!redactionEnabled) return { text, count: 0 };
  return redactModelText(text);
}

function disabledCompressorNames(
  config: Record<string, Record<string, unknown>>,
): readonly string[] {
  return Object.entries(config)
    .filter(([, value]) => value.enabled === false)
    .map(([name]) => name.replace(/_/g, "-"));
}

function disabledToolCompressorNames(
  config: Record<string, Record<string, unknown>>,
): readonly string[] {
  return Object.entries(config)
    .filter(([, value]) => value.enabled === false)
    .map(([name]) => `tool-${name.replace(/_/g, "-")}`);
}

function configForCompressor(
  config: QtkConfig,
  compressorName: string,
): Record<string, unknown> {
  if (compressorName.startsWith("tool-")) {
    return {
      ...lookupOptionTable(config.tools, compressorName.slice("tool-".length)),
      ...lookupOptionTable(config.compressors, compressorName),
    };
  }
  return lookupOptionTable(config.compressors, compressorName);
}

function lookupOptionTable(
  tables: Record<string, Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  return tables[name] ?? tables[name.replace(/-/g, "_")] ?? {};
}

function isNameDisabled(name: string, disabled: readonly string[]): boolean {
  return disabled.some((entry) => entry === name || name.endsWith(`:${entry}`));
}

function logRedacted(
  logger: QtkLogger,
  input: HookInput,
  args: Record<string, unknown>,
  shape: string,
  raw: string,
  redacted: ModelWriteResult | { readonly text: string; readonly count: number },
  extra: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const count = "redactionCount" in redacted ? redacted.redactionCount : redacted.count;
  logger.debug("redacted", {
    ...logFields(input, args),
    shape,
    bytes: formatArrow(formatBytes(raw.length), formatBytes(redacted.text.length)),
    redactions: count,
    ...extra,
  });
}

function logPassThrough(
  logger: QtkLogger,
  input: HookInput,
  args: Record<string, unknown>,
  shape: string,
  raw: string,
  reason: string,
  extra: Record<string, string | number | boolean | null | undefined> = {},
): void {
  logger.debug("passthrough", {
    ...logFields(input, args),
    shape,
    reason,
    bytes: formatBytes(raw.length),
    tok: estimateTokens(raw),
    ...extra,
  });
}

function logFields(
  input: HookInput,
  args: Record<string, unknown>,
): Record<string, string> {
  return {
    tool: input.tool,
    ...(input.tool.toLowerCase() === "bash" && typeof args.command === "string"
      ? { cmd: safeCommandLabel(args.command) }
      : {}),
  };
}

function safeCommandLabel(command: string): string {
  return sanitizeLogLabel(commandHead(command));
}

function extractCommandHead(
  tool: string,
  args: Record<string, unknown>,
): string {
  if (tool.toLowerCase() === "bash" && typeof args.command === "string") {
    return commandHead(args.command);
  }
  return tool.toLowerCase();
}

function extractHookArgs(
  input: HookInput,
  output: HookOutput,
): Record<string, unknown> {
  if (isRecord(input.args)) return input.args;
  if (isRecord(output.metadata?.args)) return output.metadata.args;
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Try to read the model id from opencode's tool-call output metadata.
 * opencode plugins receive an `output.metadata` field which sometimes
 * contains `model` (and adjacent fields). If we can't find it, returns
 * null — the savings exporter will use its default pricing.
 */
function extractModelId(output: HookOutput): string | null {
  const meta = output.metadata;
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const key of ["model", "modelID", "model_id", "modelId"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function pathToRelative(abs: string, root: string): string {
  const r = resolve(root);
  if (abs.startsWith(r + "/")) return abs.slice(r.length + 1);
  return abs;
}

export const _internal = { extractHookArgs, processCall };

// Default export for opencode plugin loader convention
export default QtkPlugin;
