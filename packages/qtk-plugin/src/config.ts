// .opencode/qtk.toml loader. Path-safe — config paths are constrained to
// inside the project directory; env-var overrides are deliberately NOT
// honoured (see SECURITY.md §3.6).

import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";
import type { QtkConfig } from "./types.ts";
import { DEFAULT_RTK_ALLOW, DEFAULT_RTK_DENY } from "./rtk.ts";

export const DEFAULT_CONFIG: QtkConfig = {
  enabled: true,
  logLevel: "info",
  dedupTtlSeconds: 60,
  compression: {
    minInputBytes: 200,
    minSavingsRatio: 0.1,
  },
  rewrite: {
    enabled: true,
  },
  rtk: {
    enabled: true,
    binary: "rtk",
    rewriteTimeoutMs: 1000,
    allow: DEFAULT_RTK_ALLOW,
    deny: DEFAULT_RTK_DENY,
  },
  redaction: {
    enabled: true,
  },
  sidecar: {
    enabled: true,
    path: null,
    requestTimeoutMs: 1000,
    startupTimeoutMs: 1500,
    maxRestarts: 3,
    minInputBytes: 200,
    disabled: [],
  },
  tee: {
    enabled: true,
    directory: ".opencode/qtk-tee",
    mode: "failures_and_compressed",
    pruneDays: 7,
  },
  stats: {
    enabled: true,
    database: join(homedir(), ".local", "share", "qtk", "stats.sqlite"),
    retentionDays: 90,
  },
  filters: {
    bundled: true,
    project: true,
    disabled: [],
  },
  compressors: {},
  tools: {},
};

/**
 * Resolve a config-supplied path safely against the project root.
 *
 * @returns absolute path on success, or null if path escapes the project
 *          root (which we refuse — see SECURITY §3 / §5).
 */
export function resolveSafePath(
  projectRoot: string,
  configPath: string,
): string | null {
  if (!configPath) return null;
  const abs = isAbsolute(configPath)
    ? configPath
    : resolve(projectRoot, configPath);
  const root = resolve(projectRoot);
  if (!abs.startsWith(root + "/") && abs !== root) {
    return null;
  }
  return abs;
}

/**
 * Load and merge config from .opencode/qtk.toml (if present) with defaults.
 * Always returns a valid config — invalid TOML files log a warning and
 * fall back to defaults.
 */
export async function loadConfig(projectRoot: string): Promise<QtkConfig> {
  let config = DEFAULT_CONFIG;
  let configuredStatsPath = false;
  for (const path of [globalConfigPath(), projectConfigPath(projectRoot)]) {
    const f = Bun.file(path);
    if (!(await f.exists())) continue;
    try {
      const text = await f.text();
      const parsed = parseToml(text);
      const qtk = parsed.qtk as Record<string, unknown> | undefined;
      const stats = qtk?.stats as Record<string, unknown> | undefined;
      if (typeof stats?.path === "string" || typeof stats?.database === "string") configuredStatsPath = true;
      config = mergeConfig(projectRoot, config, parsed);
    } catch (e) {
      console.warn(`[qtk] config load failed for ${path}:`, e);
    }
  }
  const validated = validateConfigPaths(projectRoot, config);
  const statsPath = process.env.QTK_STATS_PATH;
  if (statsPath && isAbsolute(statsPath)) {
    return { ...validated, stats: { ...validated.stats, database: statsPath } };
  }
  if (!configuredStatsPath) {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return { ...validated, stats: { ...validated.stats, database: join(base, "qtk", "stats.sqlite") } };
  }
  return validated;
}

function globalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(base, "qtk", "qtk.toml");
}

function projectConfigPath(projectRoot: string): string {
  return resolve(projectRoot, ".opencode", "qtk.toml");
}

// Minimal TOML parser — we don't pull in a dep for this. Supports:
// [section] / [section.subsection] headers
// key = "string" / key = 42 / key = true / key = ["a", "b"]
// Comments (#) and blank lines are skipped.
// Quotes: "double-quoted" only (no single, no triple).
// No inline tables, no datetime, no escapes beyond \" and \\.
// This is enough for our config format. Extend if needed.
function parseToml(src: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: Record<string, unknown> = result;
  const lines = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const path = line.slice(1, -1).trim().split(".");
      let target: Record<string, unknown> = result;
      for (const part of path) {
        const existing = target[part];
        if (
          existing &&
          typeof existing === "object" &&
          !Array.isArray(existing)
        ) {
          target = existing as Record<string, unknown>;
        } else {
          const next: Record<string, unknown> = {};
          target[part] = next;
          target = next;
        }
      }
      currentSection = target;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let valueText = line.slice(eq + 1).trim();
    if (valueText.startsWith("[") && !valueText.endsWith("]")) {
      const parts = [valueText];
      while (i + 1 < lines.length) {
        i++;
        const next = stripTomlComment(lines[i]!).trim();
        if (!next) continue;
        parts.push(next);
        if (next.endsWith("]")) break;
      }
      valueText = parts.join(" ");
    }
    currentSection[key] = parseValue(valueText);
  }

  return result;
}

function parseValue(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitArrayItems(inner).map((p) => parseValue(p.trim()));
  }
  return text; // fallback: bare string
}

function stripTomlComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function splitArrayItems(inner: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (ch === "," && !inString) {
      const item = inner.slice(start, i).trim();
      if (item) out.push(item);
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function mergeConfig(
  projectRoot: string,
  base: QtkConfig,
  override: Record<string, unknown>,
): QtkConfig {
  const qtk = (override.qtk as Record<string, unknown> | undefined) ?? {};
  const teeOverride = (qtk.tee as Record<string, unknown> | undefined) ?? {};
  const compressionOverride =
    (qtk.compression as Record<string, unknown> | undefined) ?? {};
  const rewriteOverride =
    (qtk.rewrite as Record<string, unknown> | undefined) ?? {};
  const rtkOverride = (qtk.rtk as Record<string, unknown> | undefined) ?? {};
  const redactionOverride =
    (qtk.redaction as Record<string, unknown> | undefined) ?? {};
  const sidecarOverride =
    (qtk.sidecar as Record<string, unknown> | undefined) ?? {};
  const statsOverride =
    (qtk.stats as Record<string, unknown> | undefined) ?? {};
  const filtersOverride =
    (qtk.filters as Record<string, unknown> | undefined) ?? {};
  const compOverride =
    (qtk.compressors as Record<string, Record<string, unknown>> | undefined) ??
    {};
  const toolsOverride =
    (qtk.tools as Record<string, Record<string, unknown>> | undefined) ?? {};
  const configuredRtkTimeout = rtkOverride.rewrite_timeout_ms;
  const rtkTimeout =
    typeof configuredRtkTimeout === "number" &&
    Number.isFinite(configuredRtkTimeout)
      ? configuredRtkTimeout
      : base.rtk.rewriteTimeoutMs;
  const configuredMinSavings = compressionOverride.min_savings_ratio;
  const minSavingsRatio =
    typeof configuredMinSavings === "number" &&
    Number.isFinite(configuredMinSavings)
      ? configuredMinSavings
      : base.compression.minSavingsRatio;

  return {
    enabled: (qtk.enabled as boolean | undefined) ?? base.enabled,
    logLevel:
      (qtk.log_level as QtkConfig["logLevel"] | undefined) ?? base.logLevel,
    dedupTtlSeconds:
      (qtk.dedup_ttl_seconds as number | undefined) ?? base.dedupTtlSeconds,
    compression: {
      minInputBytes:
        (compressionOverride.min_input_bytes as number | undefined) ??
        base.compression.minInputBytes,
      minSavingsRatio: Math.max(0, Math.min(0.9, minSavingsRatio)),
    },
    rewrite: {
      enabled:
        (rewriteOverride.enabled as boolean | undefined) ??
        base.rewrite.enabled,
    },
    rtk: {
      enabled: (rtkOverride.enabled as boolean | undefined) ?? base.rtk.enabled,
      binary: (rtkOverride.binary as string | undefined) ?? base.rtk.binary,
      rewriteTimeoutMs: Math.max(50, Math.min(10_000, rtkTimeout)),
      allow: readStringArray(rtkOverride.allow)?.map((entry) =>
        entry.trim().replace(/\s+/g, " "),
      ) ?? base.rtk.allow,
      deny: readStringArray(rtkOverride.deny)?.map((entry) =>
        entry.trim().replace(/\s+/g, " "),
      ) ?? base.rtk.deny,
    },
    redaction: {
      enabled:
        (redactionOverride.enabled as boolean | undefined) ??
        base.redaction.enabled,
    },
    sidecar: {
      enabled:
        (sidecarOverride.enabled as boolean | undefined) ??
        base.sidecar.enabled,
      path:
        readOptionalPath(projectRoot, sidecarOverride.path) ?? base.sidecar.path,
      requestTimeoutMs:
        (sidecarOverride.request_timeout_ms as number | undefined) ??
        base.sidecar.requestTimeoutMs,
      startupTimeoutMs:
        (sidecarOverride.startup_timeout_ms as number | undefined) ??
        base.sidecar.startupTimeoutMs,
      maxRestarts:
        (sidecarOverride.max_restarts as number | undefined) ??
        base.sidecar.maxRestarts,
      minInputBytes:
        (sidecarOverride.min_input_bytes as number | undefined) ??
        base.sidecar.minInputBytes,
      disabled:
        readStringArray(sidecarOverride.disabled) ?? base.sidecar.disabled,
    },
    tee: {
      enabled: (teeOverride.enabled as boolean | undefined) ?? base.tee.enabled,
      directory:
        (teeOverride.directory as string | undefined) ?? base.tee.directory,
      mode:
        (teeOverride.mode as QtkConfig["tee"]["mode"] | undefined) ??
        base.tee.mode,
      pruneDays:
        (teeOverride.prune_days as number | undefined) ?? base.tee.pruneDays,
    },
    stats: {
      enabled:
        (statsOverride.enabled as boolean | undefined) ?? base.stats.enabled,
      database:
        (statsOverride.path as string | undefined) ??
        (statsOverride.database as string | undefined) ?? base.stats.database,
      retentionDays: Math.max(0, (statsOverride.retention_days as number | undefined) ?? base.stats.retentionDays),
    },
    filters: {
      bundled:
        (filtersOverride.bundled as boolean | undefined) ??
        base.filters.bundled,
      project:
        (filtersOverride.project as boolean | undefined) ?? base.filters.project,
      disabled:
        readStringArray(filtersOverride.disabled) ?? base.filters.disabled,
    },
    compressors: mergeOptionTables(base.compressors, compOverride),
    tools: mergeOptionTables(base.tools, toolsOverride),
  };
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}

function readOptionalPath(
  projectRoot: string,
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) return null;
  const expanded = expandHome(value.trim());
  if (isAbsolute(expanded)) return expanded;
  return resolve(projectRoot, expanded);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function mergeOptionTables(
  base: Record<string, Record<string, unknown>>,
  override: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const canonical = canonicalOptionTableKey(key);
    out[canonical] = { ...(out[canonical] ?? {}), ...value };
  }
  return out;
}

function canonicalOptionTableKey(key: string): string {
  return key.replace(/_/g, "-");
}

function validateConfigPaths(projectRoot: string, config: QtkConfig): QtkConfig {
  const teeDirectory = resolveSafePath(projectRoot, config.tee.directory)
    ? config.tee.directory
    : DEFAULT_CONFIG.tee.directory;
  const statsDatabase = isAbsolute(config.stats.database)
    ? config.stats.database
    : resolveSafePath(projectRoot, config.stats.database)
      ? resolve(projectRoot, config.stats.database)
      : DEFAULT_CONFIG.stats.database;
  if (
    teeDirectory === config.tee.directory &&
    statsDatabase === config.stats.database
  ) {
    return config;
  }
  return {
    ...config,
    tee: { ...config.tee, directory: teeDirectory },
    stats: { ...config.stats, database: statsDatabase },
  };
}

export const _internal = { globalConfigPath, projectConfigPath };
