import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CircuitBreaker } from "../src/circuit-breaker.ts";
import { SessionCache } from "../src/cache.ts";
import { _internal } from "../src/index.ts";
import { CompressorRegistry } from "../src/registry.ts";
import { createQtkLogger } from "../src/logger.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { TeeWriter } from "../src/tee.ts";
import { StatsTracker } from "../src/stats.ts";

const isolatedStatsRoot = mkdtempSync(join(tmpdir(), "qtk-plugin-test-global-stats-"));
process.env.QTK_STATS_PATH = join(isolatedStatsRoot, "stats.sqlite");
afterAll(() => rmSync(isolatedStatsRoot, { recursive: true, force: true }));

interface CompressionRow {
  readonly session_id: string;
  readonly tool: string;
  readonly command_head: string;
  readonly compressor: string;
  readonly tee_file: string | null;
  readonly agent_read_tee: number;
  readonly agent_bypass_rerun: number;
  readonly was_cache_hit: number;
}

async function openTestStats(root: string): Promise<StatsTracker> {
  const stats = new StatsTracker(root, join(root, "stats.sqlite"));
  await stats.init();
  return stats;
}

function projectContext(root: string, stats: StatsTracker) {
  const tee = new TeeWriter({ projectRoot: root, teeDir: ".opencode/qtk-tee" });
  return {
    ...processContext(),
    projectRoot: root,
    stats,
    tee,
    teeMode: "failures_and_compressed" as const,
    config: {
      ...DEFAULT_CONFIG,
      compression: { ...DEFAULT_CONFIG.compression, minInputBytes: 0 },
      tee: { ...DEFAULT_CONFIG.tee, directory: ".opencode/qtk-tee" },
    },
  };
}

function readCompressionRows(root: string): CompressionRow[] {
  const db = new Database(join(root, "stats.sqlite"), { readonly: true });
  const rows = db.query(`
    SELECT session_id, tool, command_head, compressor, tee_file,
      agent_read_tee, agent_bypass_rerun, was_cache_hit
    FROM compressions ORDER BY rowid
  `).all() as CompressionRow[];
  db.close();
  return rows;
}

function rgOutput(): string {
  return Array.from(
    { length: 60 },
    (_, i) => `src/file-${i}.ts:${i + 1}:matching foo detail ${i}`,
  ).join("\n");
}

function numberedReadOutput(): string {
  return `<file>\n${Array.from(
    { length: 450 },
    (_, i) => `${String(i + 1).padStart(5, "0")}| const value${i} = ${i};`,
  ).join("\n")}\n</file>`;
}

function hookRtk(
  root: string,
  body: string,
  disabled = false,
): { log: string; setBody: (body: string) => void } {
  const binary = join(root, "rtk");
  const log = join(root, "rtk-argv.log");
  writeFileSync(log, "");
  const setBody = (nextBody: string): void => {
    writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n${nextBody}\n`);
    chmodSync(binary, 0o755);
  };
  setBody(body);
  writeHookConfig(root, binary, disabled);
  return { log, setBody };
}

function writeHookConfig(
  root: string,
  binary: string,
  disabled = false,
  allow?: readonly string[],
  deny?: readonly string[],
): void {
  mkdirSync(join(root, ".opencode"), { recursive: true });
  writeFileSync(
    join(root, ".opencode", "qtk.toml"),
    `[qtk.rtk]\nenabled = ${!disabled}\nbinary = "${binary}"\n${allow ? `allow = [${allow.map((entry) => `"${entry}"`).join(", ")}]\n` : ""}${deny ? `deny = [${deny.map((entry) => `"${entry}"`).join(", ")}]\n` : ""}[qtk.sidecar]\nenabled = false\n`,
  );
}

function processContext(logs?: string[]) {
  return {
    projectRoot: "/tmp",
    registry: new CompressorRegistry(),
    sidecarCompressors: [],
    cache: new SessionCache(),
    breaker: new CircuitBreaker(),
    tee: null,
    stats: null,
    savingsExporter: {
      setSessionId() {},
      setModelId() {},
      record() {},
    },
    logger: logs
      ? createQtkLogger({
          logLevel: "debug",
          sink: (line) => logs.push(line),
        })
      : createQtkLogger({ logLevel: "error" }),
    dedupTtlMs: 60_000,
    teeMode: "never" as const,
    redactionEnabled: true,
    config: DEFAULT_CONFIG,
  };
}

describe("opencode tool hook compatibility", () => {
  test("labels unchanged lossless generic task text kept_exact", async () => {
    const raw = `# Task report\n\n${Array.from({ length: 16 }, (_, index) => `The task inspected component ${index} and found its exact behavior unchanged.`).join("\n")}`;
    const result = await _internal.processCall(
      { tool: "task", sessionID: "exact-task", callID: "exact-task", args: {} },
      { output: raw },
      processContext(),
    );
    expect(result).toMatchObject({ outcome: "passthrough", reason: "kept_exact" });
  });

  test("keeps built-in answer tools exact when no compressor matches", async () => {
    const text = "Question response that should remain untouched. ".repeat(10);
    const result = await _internal.processCall(
      { tool: "question", sessionID: "question", callID: "question", args: {} },
      { output: text },
      processContext(),
    );
    expect(result).toMatchObject({ outcome: "passthrough", reason: "kept_exact" });
  });

  test("classifies generic-text policy exclusions separately from unmatched tools", async () => {
    const raw = "This answer is deliberately retained exactly. ".repeat(8);
    const policyExcluded = await _internal.processCall(
      { tool: "serena_read_memory", sessionID: "excluded-tool", callID: "excluded-tool", args: {} },
      { output: raw },
      processContext(),
    );
    const unmatched = await _internal.processCall(
      { tool: "webfetch", sessionID: "unknown-tool", callID: "unknown-tool", args: {} },
      { output: raw },
      processContext(),
    );
    expect(policyExcluded).toMatchObject({ outcome: "passthrough", reason: "kept_exact" });
    expect(unmatched).toMatchObject({ outcome: "passthrough", reason: "no_compressor" });
  });

  test("records actual text size for excluded edit output", async () => {
    const text = "<output>Applied one source edit.</output>";
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-excluded-bytes-"));
    const previousStatsPath = process.env.QTK_STATS_PATH;
    process.env.QTK_STATS_PATH = join(root, "stats.sqlite");
    try {
      const hooks = await _internal({ directory: root } as never);
      await hooks["tool.execute.after"]!({ tool: "edit", sessionID: "edit", callID: "edit", args: {} } as never, { output: text } as never);
      const db = new Database(join(root, "stats.sqlite"), { readonly: true });
      const row = db.query("SELECT bytes_in, bytes_out FROM calls").get() as { bytes_in: number; bytes_out: number };
      expect(row).toEqual({ bytes_in: new TextEncoder().encode(text).length, bytes_out: new TextEncoder().encode(text).length });
      db.close();
    } finally {
      if (previousStatsPath === undefined) delete process.env.QTK_STATS_PATH;
      else process.env.QTK_STATS_PATH = previousStatsPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("labels Read output below its line threshold small", async () => {
    const raw = `<file>\n${Array.from({ length: 100 }, (_, index) => `${String(index + 1).padStart(5, "0")}| const value${index} = ${index};`).join("\n")}\n</file>`;
    const ctx = processContext();
    const result = await _internal.processCall(
      { tool: "read", sessionID: "small-read", callID: "small-read", args: {} },
      { output: raw },
      { ...ctx, config: { ...ctx.config, compression: { ...ctx.config.compression, minInputBytes: 0 } } },
    );
    expect(result).toMatchObject({ outcome: "passthrough", reason: "small" });
  });

  test("logs one call row with canonical outcomes for after-hook calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-calls-"));
    const statsPath = join(root, "global", "stats.sqlite");
    const previousStatsPath = process.env.QTK_STATS_PATH;
    process.env.QTK_STATS_PATH = statsPath;
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(join(root, ".opencode", "qtk.toml"), "[qtk.stats]\nenabled = true\nretention_days = 0\n[qtk.sidecar]\nenabled = false\n[qtk.tee]\nenabled = true\ndirectory = \".opencode/qtk-tee\"\n");
    try {
      const hooks = await _internal({ directory: root } as never);
      const raw = await Bun.file(new URL("./fixtures/git/status-long.input.txt", import.meta.url)).text();
      const run = async (tool: string, command: string, text: string, callID: string, args: Record<string, unknown> = { command }) => {
        const output = { output: text };
        await hooks["tool.execute.after"]!({ tool, sessionID: "calls-session", callID, args } as never, output as never);
        return output.output;
      };
      await run("bash", "git status", raw, "compressed-call");
      await run("bash", "git status", raw, "cache-call");
      await run("read", "", "tiny", "small-call");
      await run("tool-no-match", "", "unmatched output that is deliberately longer than two hundred bytes ".repeat(6), "unmatched-call");
      await run("bash", "rtk git status", raw, "rtk-call");
      await run("bash", "QTK_DISABLED=1 git status", raw, "bypass-call");
      await run("read", "", `recovered\n${"line\n".repeat(50)}`, "recall-call", { filePath: "./.opencode/qtk-tee/compressed-call.log" });
      const strictRoot = join(root, "strict-project");
      mkdirSync(join(strictRoot, ".opencode"), { recursive: true });
      writeFileSync(join(strictRoot, ".opencode", "qtk.toml"), "[qtk.compression]\nmin_savings_ratio = 0.8\n[qtk.sidecar]\nenabled = false\n");
      const strictHooks = await _internal({ directory: strictRoot } as never);
      await strictHooks["tool.execute.after"]!({ tool: "bash", sessionID: "calls-session", callID: "not-worth-call", args: { command: "git status" } } as never, { output: raw } as never);

      const db = new Database(statsPath, { readonly: true });
      const rows = db.query("SELECT tool, outcome, reason FROM calls ORDER BY id").all();
      expect(rows).toEqual([
        { tool: "bash", outcome: "compressed", reason: "git-status" },
        { tool: "bash", outcome: "cache_hit", reason: "session-cache" },
        { tool: "read", outcome: "passthrough", reason: "small" },
        { tool: "tool-no-match", outcome: "passthrough", reason: "no_compressor" },
        { tool: "bash", outcome: "rtk", reason: null },
        { tool: "bash", outcome: "bypass", reason: null },
        { tool: "read", outcome: "recall", reason: null },
        { tool: "bash", outcome: "passthrough", reason: "not_worth_it" },
      ]);
      db.close();
    } finally {
      if (previousStatsPath === undefined) delete process.env.QTK_STATS_PATH;
      else process.env.QTK_STATS_PATH = previousStatsPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("RTK rewrite takes precedence and decline falls back to QTK rewrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-rtk-"));
    const fixture = hookRtk(root, "printf 'pytest -q tests'; exit 3");
    try {
      const hooks = await _internal({ directory: root } as never);
      const accepted = { args: { command: "pytest tests" } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, accepted as never);
      expect(accepted.args.command).toBe("pytest -q tests");
      expect(await Bun.file(fixture.log).text()).toContain("pytest tests\n");

      fixture.setBody("exit 1");
      const declined = { args: { command: "pytest tests" } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, declined as never);
      expect(declined.args.command).toBe("pytest -q tests");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("RTK denial leaves the original command untouched without QTK rewrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-rtk-deny-"));
    const fixture = hookRtk(root, "exit 2");
    try {
      const hooks = await _internal({ directory: root } as never);
      const output = { args: { command: "pytest tests" } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, output as never);
      expect(output.args.command).toBe("pytest tests");
      expect(await Bun.file(fixture.log).text()).toContain("pytest tests\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["git diff", "rtk git diff", "rtk git diff"],
    ["rg foo", "rtk rg foo", "rtk rg foo"],
  ] as const)("the default wildcard honours RTK rewrite for %s", async (command, rewritten, expected) => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-rtk-allow-"));
    const fixture = hookRtk(root, `printf '%s' '${rewritten}'; exit 3`);
    try {
      const hooks = await _internal({ directory: root } as never);
      const output = { args: { command } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, output as never);
      expect(output.args.command as string).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("RTK deny keeps rg with QTK and allows other compound segments", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-rtk-deny-"));
    const fixture = hookRtk(root, "case \"$2\" in *'rtk rg foo'*) printf 'rtk rg foo' ;; *) printf '%s' 'rtk git status && rtk rg foo' ;; esac; exit 3");
    writeHookConfig(root, join(root, "rtk"), false, ["*"], ["rg"]);
    try {
      const hooks = await _internal({ directory: root } as never);
      const denied = { args: { command: "rg foo" } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, denied as never);
      expect(denied.args.command).toBe("rg foo");
      const compound = { args: { command: "git status && rg foo" } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, compound as never);
      expect(compound.args.command).toBe("rtk git status && rg foo");
      const typedProxy = { args: { command: "rtk rg foo" } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, typedProxy as never);
      expect(typedProxy.args.command).toBe("rg foo");
      const typedNative = { args: { command: "rtk read x" } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, typedNative as never);
      expect(typedNative.args.command).toBe("rtk read x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["QTK_DISABLED=1 git status", "printf 'git status --short'; exit 0", false],
    ["RTK_DISABLED=1 git status", "printf 'git status --short'; exit 0", false],
    ["rtk git status", "printf 'rtk git status'; exit 0", false],
    ["git status", "printf 'rtk git status'; exit 0", true],
  ])("RTK is skipped or disabled for %s", async (command, body, disabled) => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-rtk-skip-"));
    const fixture = hookRtk(root, body, disabled);
    try {
      const hooks = await _internal({ directory: root } as never);
      const output = { args: { command } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, output as never);
      expect(output.args.command).toBe(command === "rtk git status" ? "rtk git status" : command);
      if (command === "rtk git status") expect(await Bun.file(fixture.log).text()).toContain("rewrite\nrtk git status\n");
      else expect(await Bun.file(fixture.log).text()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing RTK leaves QTK's native quiet rewrite available", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-rtk-missing-"));
    writeHookConfig(root, join(root, "missing-rtk"));
    try {
      const hooks = await _internal({ directory: root } as never);
      const output = { args: { command: "pytest tests" } };
      await hooks["tool.execute.before"]!({ tool: "bash" } as never, output as never);
      expect(output.args.command).toBe("pytest -q tests");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("RTK commands bypass output compression while native commands compress", async () => {
    const raw = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const rtkOutput = { output: raw };
    await _internal.processCall(
      { tool: "bash", sessionID: "session-rtk", callID: "call-rtk", args: { command: "rtk git status" } },
      rtkOutput,
      processContext(),
    );
    expect(rtkOutput.output).toBe(raw);

    const nativeOutput = { output: raw };
    await _internal.processCall(
      { tool: "bash", sessionID: "session-rtk", callID: "call-native", args: { command: "git status" } },
      nativeOutput,
      processContext(),
    );
    expect(nativeOutput.output).toContain("<qtk-compressed compressor=git-status");
  });

  test("RTK recall activity is logged as recall with reason rtk", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-rtk-recall-"));
    const oldStatsPath = process.env.QTK_STATS_PATH;
    process.env.QTK_STATS_PATH = join(root, "stats.sqlite");
    const oldHome = process.env.HOME;
    const home = "/Users/x";
    process.env.HOME = home;
    try {
      const hooks = await _internal({ directory: root } as never);
      const run = async (tool: string, command: string, callID: string, args: Record<string, unknown> = { command }) =>
        hooks["tool.execute.after"]!({ tool, sessionID: "rtk-recall", callID, args } as never,
          { output: "RTK output with enough content to be handled by the hook.\n".repeat(10) } as never);
      await run("bash", "rtk recall abc", "recall");
      await run("bash", "RTK_DISABLED=1 git diff", "disabled");
      await run("read", "", "read-tee", { filePath: "/Users/x/Library/Application Support/rtk/tee/1_grep.log" });
      await run("bash", "tail -n +26 \"$HOME/Library/Application Support/rtk/tee/1_grep.log\"", "tail-tee");
      const db = new Database(join(root, "stats.sqlite"), { readonly: true });
      expect(db.query("SELECT outcome, reason FROM calls ORDER BY id").all()).toEqual([
        { outcome: "recall", reason: "rtk" },
        { outcome: "recall", reason: "rtk" },
        { outcome: "recall", reason: "rtk" },
        { outcome: "recall", reason: "rtk" },
      ]);
      db.close();
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldStatsPath === undefined) delete process.env.QTK_STATS_PATH;
      else process.env.QTK_STATS_PATH = oldStatsPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes through final text that misses the configured token savings and does not tee", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-not-worth-it-"));
    const stats = await openTestStats(root);
    try {
      const raw = await Bun.file(
        new URL("./fixtures/git/status-long.input.txt", import.meta.url),
      ).text();
      const ctx = projectContext(root, stats);
      const output = { output: raw };
      await _internal.processCall(
        {
          tool: "bash",
          sessionID: "session-not-worth-it",
          callID: "not-worth-it",
          args: { command: "git status" },
        },
        output,
        {
          ...ctx,
          config: {
            ...ctx.config,
            compression: { ...ctx.config.compression, minSavingsRatio: 0.8 },
          },
        },
      );

      expect(output.output).toBe(raw);
      expect(readCompressionRows(root)).toEqual([]);
      expect(await Bun.file(join(root, ".opencode/qtk-tee/not-worth-it.log")).exists()).toBe(false);
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default minimum savings still allows strongly compressible output", async () => {
    const raw = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const output = { output: raw };
    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-default-min-savings",
        callID: "default-min-savings",
        args: { command: "git status" },
      },
      output,
      processContext(),
    );
    expect(output.output).toContain("<qtk-compressed compressor=git-status");
  });

  test.each(["cd x && rtk rg foo", "rtk recall abc123"])(
    "preserves RTK output and recall hints for %s",
    async (command) => {
      const raw = `${"rg output line matching foo\n".repeat(60)}[full output: rtk recall abc123]`;
      const output = { output: raw };
      await _internal.processCall(
        { tool: "bash", sessionID: "session-rtk", callID: "call-rtk", args: { command } },
        output,
        processContext(),
      );
      expect(output.output).toBe(raw);
    },
  );

  test("compresses ordinary rg commands mentioning rtk", async () => {
    const output = { output: rgOutput() };
    await _internal.processCall(
      { tool: "bash", sessionID: "session-rtk", callID: "call-rg-rtk", args: { command: "rg rtk src/" } },
      output,
      processContext(),
    );
    expect(output.output).toContain("<qtk-compressed compressor=rg");
  });

  test("tee recalls bypass read compression and mark the originating row", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-tee-read-"));
    const stats = await openTestStats(root);
    try {
      const ctx = projectContext(root, stats);
      const teeOutput = { output: rgOutput() };
      await _internal.processCall(
        { tool: "bash", sessionID: "session-tee", callID: "tee-read", args: { command: "rg foo" } },
        teeOutput,
        ctx,
      );
      const [origin] = readCompressionRows(root);
      expect(origin?.tee_file).toBe(join(root, ".opencode/qtk-tee/tee-read.log"));

      const recovered = numberedReadOutput();
      const recalled = { output: recovered };
      await _internal.processCall(
        {
          tool: "read",
          sessionID: "session-tee",
          callID: "read-tee",
          args: { filePath: origin!.tee_file },
        },
        recalled,
        ctx,
      );
      expect(recalled.output).toBe(recovered);
      expect(recalled.output).not.toContain("<qtk-compressed");

      const ordinary = { output: recovered };
      await _internal.processCall(
        {
          tool: "read",
          sessionID: "session-tee",
          callID: "read-ordinary",
          args: { filePath: "/tmp/source.ts" },
        },
        ordinary,
        ctx,
      );
      expect(ordinary.output).toContain("<qtk-compressed compressor=tool-read");
      expect(readCompressionRows(root).find((row) => row.tee_file === origin!.tee_file)?.agent_read_tee).toBe(1);
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("read recognizes a tee path prefixed with ./", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-tee-dot-read-"));
    const stats = await openTestStats(root);
    try {
      const ctx = projectContext(root, stats);
      await _internal.processCall(
        { tool: "bash", sessionID: "session-dot-read", callID: "dot-read-origin", args: { command: "rg foo" } },
        { output: rgOutput() },
        ctx,
      );
      const teeFile = join(root, ".opencode/qtk-tee/dot-read-origin.log");
      const recovered = numberedReadOutput();
      const output = { output: recovered };
      await _internal.processCall(
        {
          tool: "read",
          sessionID: "session-dot-read",
          callID: "dot-read-recall",
          args: { filePath: "./.opencode/qtk-tee/dot-read-origin.log" },
        },
        output,
        ctx,
      );

      expect(output.output).toBe(recovered);
      expect(output.output).not.toContain("<qtk-compressed");
      expect(readCompressionRows(root).find((row) => row.tee_file === teeFile)?.agent_read_tee).toBe(1);
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("read does not treat a tee-directory suffix inside another path as recall", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-tee-fake-path-"));
    const stats = await openTestStats(root);
    try {
      const ctx = projectContext(root, stats);
      await _internal.processCall(
        { tool: "bash", sessionID: "session-fake", callID: "fake-origin", args: { command: "rg foo" } },
        { output: rgOutput() },
        ctx,
      );
      const teeFile = join(root, ".opencode/qtk-tee/fake-origin.log");
      const output = { output: numberedReadOutput() };
      await _internal.processCall(
        {
          tool: "read",
          sessionID: "session-fake",
          callID: "read-fake-path",
          args: { filePath: "fake.opencode/qtk-tee/fake-origin.log" },
        },
        output,
        ctx,
      );

      expect(output.output).toContain("<qtk-compressed compressor=tool-read");
      expect(readCompressionRows(root).find((row) => row.tee_file === teeFile)?.agent_read_tee).toBe(0);
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bash cat of a relative tee path is passed through and recorded as read", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-tee-cat-"));
    const stats = await openTestStats(root);
    try {
      const ctx = projectContext(root, stats);
      await _internal.processCall(
        { tool: "bash", sessionID: "session-cat", callID: "tee-cat-source", args: { command: "rg foo" } },
        { output: rgOutput() },
        ctx,
      );
      const teeFile = join(root, ".opencode/qtk-tee/tee-cat-source.log");
      const recovered = rgOutput();
      const output = { output: recovered };
      await _internal.processCall(
        {
          tool: "bash",
          sessionID: "session-cat",
          callID: "tee-cat-read",
          args: { command: "cat './.opencode/qtk-tee/tee-cat-source.log'" },
        },
        output,
        ctx,
      );

      expect(output.output).toBe(recovered);
      expect(output.output).not.toContain("<qtk-compressed");
      expect(readCompressionRows(root).find((row) => row.tee_file === teeFile)?.agent_read_tee).toBe(1);
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bash cat of a plain relative tee path is passed through and recorded as read", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-tee-plain-cat-"));
    const stats = await openTestStats(root);
    try {
      const ctx = projectContext(root, stats);
      await _internal.processCall(
        { tool: "bash", sessionID: "session-plain-cat", callID: "plain-cat-source", args: { command: "rg foo" } },
        { output: rgOutput() },
        ctx,
      );
      const teeFile = join(root, ".opencode/qtk-tee/plain-cat-source.log");
      const recovered = rgOutput();
      const output = { output: recovered };
      await _internal.processCall(
        {
          tool: "bash",
          sessionID: "session-plain-cat",
          callID: "plain-cat-read",
          args: { command: "cat .opencode/qtk-tee/plain-cat-source.log" },
        },
        output,
        ctx,
      );

      expect(output.output).toBe(recovered);
      expect(output.output).not.toContain("<qtk-compressed");
      expect(readCompressionRows(root).find((row) => row.tee_file === teeFile)?.agent_read_tee).toBe(1);
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("QTK_DISABLED reruns mark only the matching prior session compression", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-bypass-"));
    const stats = await openTestStats(root);
    try {
      const ctx = projectContext(root, stats);
      await _internal.processCall(
        { tool: "bash", sessionID: "session-a", callID: "rg-a", args: { command: "rg foo" } },
        { output: rgOutput() },
        ctx,
      );
      await _internal.processCall(
        { tool: "bash", sessionID: "session-a", callID: "rg-b", args: { command: "rg bar" } },
        { output: rgOutput() },
        ctx,
      );
      await _internal.processCall(
        {
          tool: "bash",
          sessionID: "session-a",
          callID: "bypass-a",
          args: { command: "QTK_DISABLED=1 rg foo" },
        },
        { output: "raw rerun output" },
        ctx,
      );
      const afterSessionA = readCompressionRows(root);
      expect(afterSessionA.filter((row) => row.command_head === "rg foo").map((row) => row.agent_bypass_rerun)).toEqual([1]);
      expect(afterSessionA.filter((row) => row.command_head === "rg bar").map((row) => row.agent_bypass_rerun)).toEqual([0]);

      await _internal.processCall(
        {
          tool: "bash",
          sessionID: "session-b",
          callID: "bypass-b",
          args: { command: "QTK_DISABLED=1 rg foo" },
        },
        { output: "raw rerun output" },
        ctx,
      );
      expect(readCompressionRows(root)).toEqual(afterSessionA);
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("QTK_DISABLED without a prior compression leaves stats unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-bypass-empty-"));
    const stats = await openTestStats(root);
    try {
      const ctx = projectContext(root, stats);
      await _internal.processCall(
        {
          tool: "bash",
          sessionID: "session-empty",
          callID: "bypass-empty",
          args: { command: "QTK_DISABLED=1 git status" },
        },
        { output: "nothing was compressed before" },
        ctx,
      );
      expect(readCompressionRows(root)).toEqual([]);
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses current opencode tool.execute.after input.args", async () => {
    const raw = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const output = { output: raw, metadata: {} };

    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-test",
        callID: "call-test",
        args: { command: "git status" },
      },
      output,
      processContext(),
    );

    expect(output.output).toContain("<qtk-compressed compressor=git-status");
    expect(output.output).toContain("branch=qalcode-offline-improvements");
    expect(output.output.length).toBeLessThan(raw.length);
  });

  test("keeps legacy output.metadata.args fallback", async () => {
    const raw = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const output = { output: raw, metadata: { args: { command: "git status" } } };

    await _internal.processCall(
      { tool: "bash", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(),
    );

    expect(output.output).toContain("<qtk-compressed compressor=git-status");
  });

  test("compresses MCP text content arrays in place", async () => {
    const raw = Array.from(
      { length: 40 },
      (_, i) => `src/service/file-${i}.ts`,
    ).join("\n");
    const output = {
      content: [
        { type: "text", text: raw },
        { type: "image", mimeType: "image/png", data: "abc" },
      ],
      metadata: {},
    };

    await _internal.processCall(
      { tool: "mcp_find", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        registry: new CompressorRegistry([
          {
            name: "mcp-path-list",
            category: "test",
            matches: (tool) => tool === "mcp_find",
            compress: (text) => `paths=${text.split("\n").length}`,
          },
        ]),
      },
    );

    expect(output.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("<qtk-compressed compressor=mcp-path-list"),
    });
    expect(output.content[0]!.text).toContain("paths=40");
    expect(output.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "abc",
    });
  });

  test("leaves non-text MCP content unchanged", async () => {
    const output = {
      content: [{ type: "image", mimeType: "image/png", data: "abc" }],
      metadata: {},
    };

    await _internal.processCall(
      { tool: "mcp_image", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(),
    );

    expect(output.content).toEqual([
      { type: "image", mimeType: "image/png", data: "abc" },
    ]);
  });

  test("hard-exempts Serena bootstrap tools from redaction and compression", async () => {
    const raw = `${"important onboarding line\n".repeat(80)}AKIAIOSFODNN7EXAMPLE\n`;
    for (const tool of ["serena_initial_instructions", "serena_onboarding"]) {
      const logs: string[] = [];
      const output = { output: raw };

      await _internal.processCall(
        { tool, sessionID: "session-test", callID: "call-test" },
        output,
        processContext(logs),
      );

      expect(output.output).toBe(raw);
      expect(logs).toContainEqual(expect.stringContaining("reason=tool_exempt"));
    }
  });

  test("redacts small pass-through output before the model sees it", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const output = { output: `AWS key leaked by a tool: ${secret}` };

    await _internal.processCall(
      { tool: "bash", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(),
    );

    expect(output.output).toContain("<qtk-redacted count=1");
    expect(output.output).toContain('categories=["aws-key"]');
    expect(output.output).toContain("[REDACTED_SECRET_VALUE]");
    expect(output.output).not.toContain(secret);
    expect(output.output).not.toContain("<qtk-compressed");
  });

  test("redacts compressed output before mutation", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12";
    const raw = `${"noise line\n".repeat(80)}${secret}\n`;
    const output = { output: raw };

    await _internal.processCall(
      { tool: "mcp_secret", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        registry: new CompressorRegistry([
          {
            name: "secret-summary",
            category: "test",
            matches: (tool) => tool === "mcp_secret",
            compress: () => `summary token=${secret}`,
          },
        ]),
      },
    );

    expect(output.output).toContain("<qtk-redacted count=1");
    expect(output.output).toContain('categories=["github-token"]');
    expect(output.output).toContain("<qtk-compressed compressor=secret-summary");
    expect(output.output).toContain("summary token=[REDACTED_SECRET_VALUE]");
    expect(output.output).not.toContain(secret);
  });

  test("redacts MCP pass-through text when no compressor matches", async () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890";
    const raw = `${"diagnostic line\n".repeat(30)}token=${secret}\n`;
    const output = { content: [{ type: "text", text: raw }], metadata: {} };

    await _internal.processCall(
      { tool: "mcp_plain", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        registry: new CompressorRegistry([]),
      },
    );

    expect(output.content[0]!.text).toContain("<qtk-redacted count=1");
    expect(output.content[0]!.text).toContain('categories=["ai-provider-key"]');
    expect(output.content[0]!.text).toContain("[REDACTED_SECRET_VALUE]");
    expect(output.content[0]!.text).not.toContain(secret);
  });

  test("can disable model-facing redaction in process context", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const output = { output: `AWS key leaked by a tool: ${secret}` };

    await _internal.processCall(
      { tool: "bash", sessionID: "session-test", callID: "call-test" },
      output,
      { ...processContext(), redactionEnabled: false },
    );

    expect(output.output).toBe(`AWS key leaked by a tool: ${secret}`);
  });

  test("honors per-call QTK_DISABLED bash env before redaction", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const output = { output: `AWS key leaked by a tool: ${secret}` };

    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-test",
        callID: "call-test",
        args: { command: "QTK_DISABLED=1 cat test_routes_handlers.py" },
      },
      output,
      processContext(),
    );

    expect(output.output).toBe(`AWS key leaked by a tool: ${secret}`);
  });

  test("disabled compressors pass through instead of compressing", async () => {
    const raw = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const registry = new CompressorRegistry();
    registry.disable(["git-status"]);
    const output = { output: raw, metadata: {} };

    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-test",
        callID: "call-test",
        args: { command: "git status" },
      },
      output,
      { ...processContext(), registry },
    );

    expect(output.output).toBe(raw);
  });

  test("generic MCP compression requires a recoverable tee", async () => {
    const raw = Array.from(
      { length: 60 },
      (_, i) => `packages/app/src/file-${i}.ts`,
    ).join("\n");
    const output = { content: [{ type: "text", text: raw }], metadata: {} };

    await _internal.processCall(
      { tool: "serena_get_diagnostics_for_file", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        config: { ...DEFAULT_CONFIG, compressors: { "generic-text": { allow_lossy: true } } },
      },
    );

    expect(output.content[0]!.text).toBe(raw);
  });

  test("generic MCP compression writes lossy envelope with tee", async () => {
    const raw = Array.from(
      { length: 60 },
      (_, i) => `packages/app/src/file-${i}.ts`,
    ).join("\n");
    const output = { content: [{ type: "text", text: raw }], metadata: {} };

    await _internal.processCall(
      { tool: "serena_get_diagnostics_for_file", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        config: { ...DEFAULT_CONFIG, compressors: { "generic-text": { allow_lossy: true } } },
        tee: {
          write: async () => "/tmp/.opencode/qtk-tee/call-test.log",
        } as unknown as TeeWriter,
      },
    );

    expect(output.content[0]!.text).toContain("<qtk-compressed compressor=generic-text");
    expect(output.content[0]!.text).toContain("lossy=true");
    expect(output.content[0]!.text).toContain("tee=.opencode/qtk-tee/call-test.log");
  });

  test("disabled redaction keeps compressed tee output raw", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-hook-tee-no-redact-"));
    const stats = await openTestStats(root);
    const secret = 'api_key = "sk-live-abcdefghijklmnopqrstuvwx"';
    const raw = `${Array.from(
      { length: 60 },
      (_, i) => `packages/app/src/file-${i}.ts`,
    ).join("\n")}\n${secret}\n`;
    const output = { content: [{ type: "text", text: raw }], metadata: {} };
    try {
      await _internal.processCall(
        {
          tool: "serena_get_diagnostics_for_file",
          sessionID: "session-no-redact",
          callID: "call-no-redact",
        },
        output,
        {
          ...projectContext(root, stats),
          tee: new TeeWriter({
            projectRoot: root,
            teeDir: ".opencode/qtk-tee",
            redact: false,
          }),
          redactionEnabled: false,
          config: {
            ...DEFAULT_CONFIG,
            redaction: { ...DEFAULT_CONFIG.redaction, enabled: false },
            compressors: { "generic-text": { allow_lossy: true } },
          },
        },
      );

      const teePath = join(root, ".opencode/qtk-tee/call-no-redact.log");
      expect(readFileSync(teePath, "utf8")).toBe(raw);
      expect(output.content[0]!.text).toContain("<qtk-compressed compressor=generic-text");
      expect(output.content[0]!.text).not.toContain("<qtk-redacted");
    } finally {
      stats.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generic cache hits preserve lossy tee metadata", async () => {
    const raw = Array.from(
      { length: 60 },
      (_, i) => `packages/app/src/file-${i}.ts`,
    ).join("\n");
    const cache = new SessionCache();
    const ctx = {
      ...processContext(),
      config: { ...DEFAULT_CONFIG, compressors: { "generic-text": { allow_lossy: true } } },
      cache,
      tee: {
        write: async () => "/tmp/.opencode/qtk-tee/call-test.log",
      } as unknown as TeeWriter,
    };

    await _internal.processCall(
      { tool: "serena_get_diagnostics_for_file", sessionID: "session-test", callID: "call-test" },
      { content: [{ type: "text", text: raw }], metadata: {} },
      ctx,
    );

    const repeat = { content: [{ type: "text", text: raw }], metadata: {} };
    await _internal.processCall(
      { tool: "serena_get_diagnostics_for_file", sessionID: "session-test", callID: "call-test" },
      repeat,
      { ...ctx, tee: null },
    );

    expect(repeat.content[0]!.text).toContain("<qtk-unchanged");
    expect(repeat.content[0]!.text).toContain("lossy=true");
    expect(repeat.content[0]!.text).toContain("tee=.opencode/qtk-tee/call-test.log");
  });

  test("default generic MCP compaction is lossless and never tees", async () => {
    const items = Array.from({ length: 20 }, (_, id) => ({
      id,
      state: id === 19 ? "FAILED" : "OK",
      message: id === 19 ? "critical late failure" : `item ${id}`,
    }));
    const raw = JSON.stringify({ items, nextPageToken: "tok_page_2_abc" }, null, 2);
    let teeWrites = 0;
    const output = { content: [{ type: "text", text: raw }], metadata: {} };

    await _internal.processCall(
      { tool: "grafana_query", sessionID: "session-test", callID: "call-lossless" },
      output,
      {
        ...processContext(),
        tee: {
          write: async () => {
            teeWrites += 1;
            return "/tmp/.opencode/qtk-tee/call-lossless.log";
          },
        } as unknown as TeeWriter,
      },
    );

    const text = output.content[0]!.text;
    expect(text.startsWith("<qtk-compressed compressor=generic-text")).toBe(true);
    expect(text).toContain("lossless=true");
    expect(text).not.toContain("lossy=true");
    expect(text).not.toContain("tee=");
    expect(teeWrites).toBe(0);
    const body = text.split("\n").slice(1, -1).join("\n");
    expect(JSON.parse(body)).toEqual(JSON.parse(raw));
  });

  test("default generic MCP lossless compaction works without tee", async () => {
    const raw = JSON.stringify({ records: Array.from({ length: 24 }, (_, id) => ({ id, value: "detail" })) }, null, 2);
    const output = { content: [{ type: "text", text: raw }], metadata: {} };

    await _internal.processCall(
      { tool: "grafana_query", sessionID: "session-test", callID: "call-no-tee" },
      output,
      { ...processContext(), tee: null },
    );

    expect(output.content[0]!.text).toContain("<qtk-compressed compressor=generic-text");
    expect(output.content[0]!.text).toContain("lossless=true");
    expect(output.content[0]!.text).not.toBe(raw);
  });

  test("default task fallback passes long markdown reports through", async () => {
    const raw = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n${"Detailed report prose. ".repeat(8)}`).join("\n");
    const output = { output: raw, metadata: {} };

    await _internal.processCall(
      { tool: "task", sessionID: "session-test", callID: "call-task" },
      output,
      processContext(),
    );

    expect(output.output).toBe(raw);
    expect(output.output).not.toContain("<qtk-compressed");
  });

  test("debug logger reports compression without raw output", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12";
    const raw = `${"safe but verbose line\n".repeat(80)}${secret}\n`;
    const logs: string[] = [];
    const output = { output: raw };

    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-test",
        callID: "call-test",
        args: { command: `git status ${secret}` },
      },
      output,
      {
        ...processContext(logs),
        registry: new CompressorRegistry([
          {
            name: "safe-summary",
            category: "test",
            matches: () => true,
            compress: () => "summary only",
          },
        ]),
      },
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[qtk] compressed");
    expect(logs[0]).toContain("tool=bash");
    expect(logs[0]).toContain("compressor=safe-summary");
    expect(logs[0]).toContain("bytes=");
    expect(logs[0]).toContain("saved=");
    expect(logs[0]).not.toContain(secret);
    expect(logs[0]).not.toContain("safe but verbose line");
  });

  test("debug logger reports pass-through reasons", async () => {
    const logs: string[] = [];
    const raw = `${"diagnostic line\n".repeat(30)}`;
    const output = { output: raw };

    await _internal.processCall(
      { tool: "mcp_plain", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(logs),
        registry: new CompressorRegistry([]),
      },
    );

    expect(logs).toContainEqual(
      expect.stringContaining("[qtk] passthrough"),
    );
    expect(logs[0]).toContain("reason=no_match");
    expect(logs[0]).toContain("bytes=");
    expect(logs[0]).not.toContain("diagnostic line");
  });

  test("debug logger reports redactions without leaking values", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const logs: string[] = [];
    const output = { output: `secret=${secret}` };

    await _internal.processCall(
      { tool: "bash", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(logs),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[qtk] redacted");
    expect(logs[0]).toContain("redactions=1");
    expect(logs[0]).not.toContain(secret);
  });
});
