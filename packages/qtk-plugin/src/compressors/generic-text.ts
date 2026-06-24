// Conservative fallback compressor for text-heavy MCP/task outputs.
//
// This is intentionally last in the registry. It only compresses recognizable
// shapes and returns raw unchanged for anything ambiguous.

import { basename, dirname } from "node:path/posix";
import type { Compressor } from "../types.ts";

const MIN_INPUT_BYTES = 500;
const MAX_INPUT_BYTES = 500_000;
const MAX_GROUPS = 20;
const MAX_ITEMS_PER_GROUP = 8;
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
  "serena_find_symbol",
  "serena_find_declaration",
  "serena_find_implementations",
  "serena_find_referencing_symbols",
  "serena_get_symbols_overview",
]);

const EXCLUDED_PREFIXES = ["codebase-memory-mcp_", "octocode_local"];

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

  compress(raw: string): string {
    if (!raw || raw.length < MIN_INPUT_BYTES || raw.length > MAX_INPUT_BYTES) {
      return raw;
    }

    for (const candidate of [
      compressJson(raw),
      compressDiagnostics(raw),
      compressPathList(raw),
      compressRepeatedLines(raw),
      compressMarkdown(raw),
    ]) {
      if (candidate && candidate.length < raw.length) return candidate;
    }
    return raw;
  },
};

function compressJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^[{[]/.test(trimmed)) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const out = ["json summary:", ...summarizeJson(value, "$", 0)];
  if (out.length < 3) return null;
  return shorter(raw, out.join("\n"));
}

function summarizeJson(value: unknown, path: string, depth: number): string[] {
  if (depth > 2) return [`${path}: ${typeOf(value)}`];
  if (Array.isArray(value)) {
    const out = [`${path}: array(${value.length})`];
    if (value.length > 0) out.push(...summarizeJson(value[0], `${path}[]`, depth + 1));
    return out;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const keys = entries.map(([key]) => key);
    const out = [`${path}: object(${entries.length}) keys=${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", ..." : ""}`];
    for (const [key, child] of entries.slice(0, 8)) {
      out.push(...summarizeJson(child, `${path}.${key}`, depth + 1));
    }
    return out;
  }
  return [`${path}: ${typeOf(value)}`];
}

function compressDiagnostics(raw: string): string | null {
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
  if (total < 8 || total < lines.length * 0.35) return null;

  const groups = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  const out = [`${total} diagnostics across ${byFile.size} files:`];
  for (const [file, messages] of groups.slice(0, MAX_GROUPS)) {
    out.push(`${file} (${messages.length})`);
    for (const message of messages.slice(0, 3)) out.push(`  ${message}`);
    if (messages.length > 3) out.push(`  ... +${messages.length - 3} more`);
  }
  if (groups.length > MAX_GROUPS) out.push(`... +${groups.length - MAX_GROUPS} more files`);
  return shorter(raw, out.join("\n"));
}

function parseDiagnostic(line: string): { file: string; message: string } | null {
  const fileLine = line.match(/^([^:\s][^:]*\.[A-Za-z0-9]+):(\d+)(?::\d+)?:\s*(.+)$/);
  if (fileLine) return { file: fileLine[1]!, message: `L${fileLine[2]}: ${trim(fileLine[3]!)}` };

  const lsp = line.match(/^(.+\.[A-Za-z0-9]+)\s+\((Error|Warning|Info|Hint)\):\s*(.+)$/i);
  if (lsp) return { file: lsp[1]!.trim(), message: `${lsp[2]}: ${trim(lsp[3]!)}` };
  return null;
}

function compressPathList(raw: string): string | null {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 20) return null;
  const paths = lines.filter(looksLikePath);
  if (paths.length < 20 || paths.length < lines.length * 0.75) return null;

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
  for (const [dir, names] of sorted.slice(0, MAX_GROUPS)) {
    names.sort((a, b) => a.localeCompare(b));
    const shown = names.slice(0, MAX_ITEMS_PER_GROUP).join(", ");
    const more = names.length > MAX_ITEMS_PER_GROUP ? `, ... +${names.length - MAX_ITEMS_PER_GROUP}` : "";
    out.push(`  ${dir} (${names.length}): ${shown}${more}`);
  }
  if (sorted.length > MAX_GROUPS) out.push(`  ... +${sorted.length - MAX_GROUPS} more dirs`);
  return shorter(raw, out.join("\n"));
}

function compressMarkdown(raw: string): string | null {
  const lines = raw.split("\n");
  if (lines.length < 80) return null;

  const out: string[] = ["text outline:"];
  const visible = stripMarkdownCodeBlocks(lines).map((line) => line.trim());
  const headings = visible.filter((line) => /^#{1,4}\s+/.test(line));
  const bullets = visible.filter((line) => /^[-*+]\s+\S/.test(line)).slice(0, 20);
  const prose = visible
    .filter((line) => line && !/^#{1,4}\s+/.test(line) && !/^[-*+]\s+\S/.test(line))
    .slice(0, 8);

  if (headings.length === 0 && bullets.length < 10) return null;
  for (const heading of headings.slice(0, 30)) out.push(trim(heading));
  if (headings.length > 30) out.push(`... +${headings.length - 30} more headings`);
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

function compressRepeatedLines(raw: string): string | null {
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length < 30) return null;
  const counts = new Map<string, number>();
  for (const line of lines) {
    const normalized = normalizeLogEntropy(line);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1]);
  const repeatedCount = repeated.reduce((sum, [, count]) => sum + count, 0);
  if (repeated.length === 0 || repeatedCount < lines.length * 0.5) return null;

  const notable = uniqueNotableLines(lines).slice(0, 20);
  const out = [`${lines.length} lines; ${repeatedCount} repeated after normalization:`];
  for (const [line, count] of repeated.slice(0, 20)) out.push(`  x${count}: ${trim(normalizeLogEntropy(line))}`);
  if (repeated.length > 20) out.push(`  ... +${repeated.length - 20} more repeated lines`);
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
