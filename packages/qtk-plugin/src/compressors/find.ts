// `find` / `fd` path-list compressor.
//
// These commands often produce hundreds of one-path-per-line results. We group
// paths by their containing directory and show a capped sample per group.

import { dirname, basename } from "node:path/posix";
import type { Compressor, CompressorContext } from "../types.ts";
import { intOption } from "../options.ts";

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

  compress(raw: string, ctx: CompressorContext): string {
    const minInputBytes = intOption(ctx.config, "min_input_bytes", 200, {
      min: 0,
    });
    const maxInputBytes = intOption(ctx.config, "max_input_bytes", 500_000, {
      min: 1_000,
    });
    if (!raw || raw.length < minInputBytes || raw.length > maxInputBytes || raw.includes("\0")) {
      return raw;
    }

    const paths = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(looksLikePath);

    const minPaths = intOption(ctx.config, "min_paths", 20, {
      min: 1,
      max: 1000,
    });
    if (paths.length < minPaths) return raw;

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

    const maxGroups = intOption(ctx.config, "max_groups", 20, {
      min: 1,
      max: 500,
    });
    const maxNamesPerGroup = intOption(ctx.config, "max_names_per_group", 8, {
      min: 1,
      max: 100,
    });
    for (const [dir, names] of sorted.slice(0, maxGroups)) {
      names.sort((a, b) => a.localeCompare(b));
      const shown = names.slice(0, maxNamesPerGroup).join(", ");
      const more =
        names.length > maxNamesPerGroup
          ? `, ... +${names.length - maxNamesPerGroup}`
          : "";
      out.push(`  ${dir} (${names.length}): ${shown}${more}`);
    }

    if (sorted.length > maxGroups) {
      const remaining = sorted
        .slice(maxGroups)
        .reduce((n, [, names]) => n + names.length, 0);
      out.push(`  ... ${sorted.length - maxGroups} more dirs (${remaining} paths)`);
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
