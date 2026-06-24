// `find` / `fd` path-list compressor.
//
// These commands often produce hundreds of one-path-per-line results. We group
// paths by their containing directory and show a capped sample per group.

import { dirname, basename } from "node:path/posix";
import type { Compressor } from "../types.ts";

const MAX_GROUPS = 20;
const MAX_NAMES_PER_GROUP = 8;
const MAX_INPUT_BYTES = 500_000;

export const findCompressor: Compressor = {
  name: "find",
  category: "filesystem",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (!/^(find|fd)(\s|$)/.test(cmd)) return false;
    // Avoid complex shell compositions where output may not be a plain path list.
    if (/[|&;><`]/.test(cmd)) return false;
    if (/(^|\s)(-exec|-execdir|-delete|-print0)(\s|$)/.test(cmd)) return false;
    if (/(^|\s)(-x|--exec|-X|--exec-batch)(\s|$)/.test(cmd)) return false;
    return true;
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200 || raw.length > MAX_INPUT_BYTES || raw.includes("\0")) {
      return raw;
    }

    const paths = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(looksLikePath);

    if (paths.length < 20) return raw;

    const groups = new Map<string, string[]>();
    for (const path of paths) {
      const normalized = path.replace(/^\.\//, "");
      const parent = dirname(normalized);
      const dir = parent === "." ? "./" : parent === "/" ? "/" : `${parent}/`;
      const names = groups.get(dir) ?? [];
      names.push(basename(normalized));
      groups.set(dir, names);
    }

    if (groups.size === 0) return raw;

    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const out: string[] = [`${paths.length} paths in ${groups.size} directories:`];

    for (const [dir, names] of sorted.slice(0, MAX_GROUPS)) {
      names.sort((a, b) => a.localeCompare(b));
      const shown = names.slice(0, MAX_NAMES_PER_GROUP).join(", ");
      const more =
        names.length > MAX_NAMES_PER_GROUP
          ? `, ... +${names.length - MAX_NAMES_PER_GROUP}`
          : "";
      out.push(`  ${dir} (${names.length}): ${shown}${more}`);
    }

    if (sorted.length > MAX_GROUPS) {
      const remaining = sorted.slice(MAX_GROUPS).reduce((n, [, names]) => n + names.length, 0);
      out.push(`  ... ${sorted.length - MAX_GROUPS} more dirs (${remaining} paths)`);
    }

    const result = out.join("\n");
    if (result.length >= raw.length) return raw;
    return result;
  },
};

function looksLikePath(value: string): boolean {
  if (!value || /\s{2,}/.test(value)) return false;
  if (/^(error|warning|usage):/i.test(value)) return false;
  return value.includes("/") || value.startsWith(".") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}
