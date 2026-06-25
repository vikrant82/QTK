// Conservative fallback compressor for text-heavy MCP/task outputs.
//
// This is intentionally last in the registry. It only compresses recognizable
// shapes and returns raw unchanged for anything ambiguous.

import { basename, dirname } from "node:path/posix";
import type { Compressor, CompressorContext } from "../types.ts";
import { intOption, numberOption, stringArrayOption } from "../options.ts";
const EXCLUDED_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
  "todowrite",
  "question",
  "skill",
  "permission",
  "bash",
  "read",
  "grep",
  "glob",
  "serena_replace_content",
  "serena_replace_symbol_body",
  "serena_insert_before_symbol",
  "serena_insert_after_symbol",
  "serena_rename_symbol",
  "serena_write_memory",
  "serena_edit_memory",
  "serena_delete_memory",
  "serena_rename_memory",
  "serena_list_memories",
  "serena_read_memory",
  "serena_initial_instructions",
  "serena_onboarding",
  "serena_find_symbol",
  "serena_find_declaration",
  "serena_find_implementations",
  "serena_find_referencing_symbols",
  "serena_get_symbols_overview",
]);

const EXCLUDED_PREFIXES = ["codebase-memory-mcp_", "octocode_"];

export const genericTextCompressor: Compressor = {
  name: "generic-text",
  category: "generic",

  matches(tool: string): boolean {
    const normalized = tool.toLowerCase();
    if (EXCLUDED_TOOLS.has(normalized)) return false;
    if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      return false;
    }
    return normalized === "task" || normalized.includes("_");
  },

  compress(raw: string, ctx: CompressorContext): string {
    const minInputBytes = intOption(ctx.config, "min_input_bytes", 500, {
      min: 0,
    });
    const maxInputBytes = intOption(ctx.config, "max_input_bytes", 500_000, {
      min: 1_000,
    });
    if (!raw || raw.length < minInputBytes || raw.length > maxInputBytes) {
      return raw;
    }

    for (const candidate of [
      compressJson(raw, ctx.config),
      compressDiagnostics(raw, ctx.config),
      compressPathList(raw, ctx.config),
      compressRepeatedLines(raw, ctx.config),
      compressMarkdown(raw, ctx.config),
    ]) {
      if (candidate && candidate.length < raw.length) return candidate;
    }
    return raw;
  },
};

function compressJson(raw: string, config: Record<string, unknown>): string | null {
  if (stringArrayOption(config, "disabled_shapes").includes("json")) return null;
  const trimmed = raw.trim();
  if (!/^[{[]/.test(trimmed)) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const maxKeys = intOption(config, "json_max_keys", 12, { min: 1, max: 200 });
  const maxItems = intOption(config, "json_max_items", 8, { min: 1, max: 200 });
  const maxDepth = intOption(config, "json_max_depth", 2, { min: 0, max: 10 });
  const out = ["json summary:", ...summarizeJson(value, "$", 0, {
    maxDepth,
    maxItems,
    maxKeys,
  })];
  if (out.length < 3) return null;
  return shorter(raw, out.join("\n"));
}

function summarizeJson(
  value: unknown,
  path: string,
  depth: number,
  opts: { readonly maxDepth: number; readonly maxItems: number; readonly maxKeys: number },
): string[] {
  if (depth > opts.maxDepth) return [`${path}: ${typeOf(value)}`];
  if (Array.isArray(value)) {
    const out = [`${path}: array(${value.length})`];
    if (value.length > 0) out.push(...summarizeJson(value[0], `${path}[]`, depth + 1, opts));
    return out;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const keys = entries.map(([key]) => key);
    const out = [`${path}: object(${entries.length}) keys=${keys.slice(0, opts.maxKeys).join(", ")}${keys.length > opts.maxKeys ? ", ..." : ""}`];
    for (const [key, child] of entries.slice(0, opts.maxItems)) {
      out.push(...summarizeJson(child, `${path}.${key}`, depth + 1, opts));
    }
    return out;
  }
  return [`${path}: ${typeOf(value)}`];
}

function compressDiagnostics(raw: string, config: Record<string, unknown>): string | null {
  if (stringArrayOption(config, "disabled_shapes").includes("diagnostics")) return null;
  const lines = raw.split("\n").filter(Boolean);
  const byFile = new Map<string, string[]>();

  for (const line of lines) {
    const diagnostic = parseDiagnostic(line);
    if (!diagnostic) continue;
    const items = byFile.get(diagnostic.file) ?? [];
    items.push(diagnostic.message);
    byFile.set(diagnostic.file, items);
  }

  const total = [...byFile.values()].reduce((sum, items) => sum + items.length, 0);
  const minDiagnostics = intOption(config, "diagnostics_min_count", 8, {
    min: 1,
    max: 1000,
  });
  const minRatio = numberOption(config, "diagnostics_min_ratio", 0.35, {
    min: 0.01,
    max: 1,
  });
  if (total < minDiagnostics || total < lines.length * minRatio) return null;

  const groups = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  const out = [`${total} diagnostics across ${byFile.size} files:`];
  const maxGroups = intOption(config, "max_groups", 20, { min: 1, max: 500 });
  const maxMessagesPerGroup = intOption(config, "diagnostics_per_file", 3, {
    min: 1,
    max: 100,
  });
  for (const [file, messages] of groups.slice(0, maxGroups)) {
    out.push(`${file} (${messages.length})`);
    for (const message of messages.slice(0, maxMessagesPerGroup)) out.push(`  ${message}`);
    if (messages.length > maxMessagesPerGroup) out.push(`  ... +${messages.length - maxMessagesPerGroup} more`);
  }
  if (groups.length > maxGroups) out.push(`... +${groups.length - maxGroups} more files`);
  return shorter(raw, out.join("\n"));
}

function parseDiagnostic(line: string): { file: string; message: string } | null {
  const fileLine = line.match(/^([^:\s][^:]*\.[A-Za-z0-9]+):(\d+)(?::\d+)?:\s*(.+)$/);
  if (fileLine) return { file: fileLine[1]!, message: `L${fileLine[2]}: ${trim(fileLine[3]!)}` };

  const lsp = line.match(/^(.+\.[A-Za-z0-9]+)\s+\((Error|Warning|Info|Hint)\):\s*(.+)$/i);
  if (lsp) return { file: lsp[1]!.trim(), message: `${lsp[2]}: ${trim(lsp[3]!)}` };
  return null;
}

function compressPathList(raw: string, config: Record<string, unknown>): string | null {
  if (stringArrayOption(config, "disabled_shapes").includes("path_list")) return null;
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const minPaths = intOption(config, "path_min_count", 20, { min: 1, max: 1000 });
  if (lines.length < minPaths) return null;
  const paths = lines.filter(looksLikePath);
  const minRatio = numberOption(config, "path_min_ratio", 0.75, {
    min: 0.01,
    max: 1,
  });
  if (paths.length < minPaths || paths.length < lines.length * minRatio) return null;

  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const normalized = path.replace(/^\.\//, "");
    const parent = dirname(normalized);
    const dir = parent === "." ? "./" : parent === "/" ? "/" : `${parent}/`;
    const items = groups.get(dir) ?? [];
    items.push(basename(normalized));
    groups.set(dir, items);
  }

  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const out = [`${paths.length} paths in ${groups.size} directories:`];
  const maxGroups = intOption(config, "max_groups", 20, { min: 1, max: 500 });
  const maxItemsPerGroup = intOption(config, "max_items_per_group", 8, {
    min: 1,
    max: 100,
  });
  for (const [dir, names] of sorted.slice(0, maxGroups)) {
    names.sort((a, b) => a.localeCompare(b));
    const shown = names.slice(0, maxItemsPerGroup).join(", ");
    const more = names.length > maxItemsPerGroup ? `, ... +${names.length - maxItemsPerGroup}` : "";
    out.push(`  ${dir} (${names.length}): ${shown}${more}`);
  }
  if (sorted.length > maxGroups) out.push(`  ... +${sorted.length - maxGroups} more dirs`);
  return shorter(raw, out.join("\n"));
}

function compressMarkdown(raw: string, config: Record<string, unknown>): string | null {
  if (stringArrayOption(config, "disabled_shapes").includes("markdown")) return null;
  const lines = raw.split("\n");
  const minLines = intOption(config, "markdown_min_lines", 80, {
    min: 1,
    max: 100_000,
  });
  if (lines.length < minLines) return null;

  const out: string[] = ["text outline:"];
  const visible = stripMarkdownCodeBlocks(lines).map((line) => line.trim());
  const headings = visible.filter((line) => /^#{1,4}\s+/.test(line));
  const maxBullets = intOption(config, "markdown_max_bullets", 20, {
    min: 0,
    max: 500,
  });
  const bullets = visible.filter((line) => /^[-*+]\s+\S/.test(line)).slice(0, maxBullets);
  const prose = visible
    .filter((line) => line && !/^#{1,4}\s+/.test(line) && !/^[-*+]\s+\S/.test(line))
    .slice(0, intOption(config, "markdown_max_lead_lines", 8, { min: 0, max: 100 }));

  if (headings.length === 0 && bullets.length < 10) return null;
  const maxHeadings = intOption(config, "markdown_max_headings", 30, {
    min: 1,
    max: 500,
  });
  for (const heading of headings.slice(0, maxHeadings)) out.push(trim(heading));
  if (headings.length > maxHeadings) out.push(`... +${headings.length - maxHeadings} more headings`);
  if (prose.length > 0) {
    out.push("lead:");
    for (const line of prose) out.push(`  ${trim(line)}`);
  }
  if (bullets.length > 0) {
    out.push("bullets:");
    for (const bullet of bullets) out.push(`  ${trim(bullet)}`);
  }
  out.push(`(${lines.length} original lines)`);
  return shorter(raw, out.join("\n"));
}

function compressRepeatedLines(raw: string, config: Record<string, unknown>): string | null {
  if (stringArrayOption(config, "disabled_shapes").includes("repeated_lines")) return null;
  const lines = raw.split("\n").filter(Boolean);
  const minLines = intOption(config, "repeated_min_lines", 30, { min: 1, max: 100_000 });
  if (lines.length < minLines) return null;
  const counts = new Map<string, number>();
  for (const line of lines) {
    const normalized = normalizeLogEntropy(line);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= intOption(config, "repeated_min_count", 3, { min: 2, max: 1000 }))
    .sort((a, b) => b[1] - a[1]);
  const repeatedCount = repeated.reduce((sum, [, count]) => sum + count, 0);
  const minRatio = numberOption(config, "repeated_min_ratio", 0.5, {
    min: 0.01,
    max: 1,
  });
  if (repeated.length === 0 || repeatedCount < lines.length * minRatio) return null;

  const maxNotable = intOption(config, "repeated_max_notable", 20, {
    min: 0,
    max: 500,
  });
  const maxRepeated = intOption(config, "repeated_max_groups", 20, {
    min: 1,
    max: 500,
  });
  const notable = uniqueNotableLines(lines).slice(0, maxNotable);
  const out = [`${lines.length} lines; ${repeatedCount} repeated after normalization:`];
  for (const [line, count] of repeated.slice(0, maxRepeated)) out.push(`  x${count}: ${trim(normalizeLogEntropy(line))}`);
  if (repeated.length > maxRepeated) out.push(`  ... +${repeated.length - maxRepeated} more repeated lines`);
  if (notable.length > 0) {
    out.push("notable unique lines:");
    for (const line of notable) out.push(`  ${trim(line)}`);
  }
  return shorter(raw, out.join("\n"));
}

function looksLikePath(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  if (/^(error|warning|usage):/i.test(value)) return false;
  if (/^(\/\/|import\b|export\b|return\b|const\b|let\b|var\b)/.test(value)) return false;
  if (/[{}()[\];,'"<>|`]/.test(value)) return false;
  return /^(?:\.?\.?\/|~\/|[A-Za-z]:\\|[A-Za-z0-9_@.+-]+\/)[^\s]+$/.test(value);
}

function stripMarkdownCodeBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

function isNotableLine(line: string): boolean {
  return /\b(error|exception|failed|failure|fatal|panic|traceback|warning|warn)\b/i.test(line);
}

function uniqueNotableLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (!isNotableLine(line)) continue;
    const key = normalizeLogEntropy(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function normalizeLogEntropy(line: string): string {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "[TIMESTAMP]")
    .replace(/\b\d+ms\b/g, "[DURATION]")
    .replace(/\bpid=\d+\b/g, "pid=[PID]")
    .replace(/\brequest[_-]?id=[A-Za-z0-9._-]+\b/gi, "request_id=[ID]");
}

function shorter(raw: string, candidate: string): string | null {
  return candidate && candidate.length < raw.length ? candidate : null;
}

function trim(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}…` : value;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
