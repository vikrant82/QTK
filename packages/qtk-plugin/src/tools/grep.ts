// `Grep` tool compressor — opencode's built-in grep wraps ripgrep and
// formats output as:
//
//   src/foo.ts:
//     Line 17: useEffect(() => { ... })
//     Line 42: useEffect(() => { ... })
//
//   src/bar.ts:
//     Line 8: useEffect imported here
//
// Strategy: same as rg compressor — group by file, cap top 3 matches per
// file, total cap on files shown.

import type { Compressor, CompressorContext } from "../types.ts";
import { intOption } from "../options.ts";

export const grepToolCompressor: Compressor = {
  name: "tool-grep",
  category: "built-in-tool",

  matches(tool: string): boolean {
    return tool.toLowerCase() === "grep";
  },

  compress(raw: string, ctx: CompressorContext): string {
    const minInputBytes = intOption(ctx.config, "min_input_bytes", 500, {
      min: 0,
    });
    const minMatches = intOption(ctx.config, "min_matches", 10, {
      min: 1,
      max: 1000,
    });
    const maxFilesShown = intOption(ctx.config, "max_files_shown", 15, {
      min: 1,
      max: 500,
    });
    const maxMatchesPerFile = intOption(ctx.config, "max_matches_per_file", 3, {
      min: 1,
      max: 100,
    });
    const maxLineChars = intOption(ctx.config, "max_line_chars", 100, {
      min: 20,
      max: 1000,
    });
    if (!raw || raw.length < minInputBytes) return raw;

    const lines = raw.split("\n");
    type Match = { line: number; text: string };
    const byFile = new Map<string, Match[]>();

    let currentFile: string | null = null;
    for (const line of lines) {
      if (line.endsWith(":") && !line.includes(" ")) {
        currentFile = line.slice(0, -1).trim();
        if (currentFile) byFile.set(currentFile, []);
        continue;
      }
      const m = line.match(/^\s+Line\s+(\d+):\s*(.*)$/);
      if (m && currentFile) {
        const arr = byFile.get(currentFile) ?? [];
        arr.push({ line: Number.parseInt(m[1]!, 10), text: m[2]! });
        byFile.set(currentFile, arr);
      }
    }

    if (byFile.size === 0) return raw;

    const totalMatches = [...byFile.values()].reduce((a, b) => a + b.length, 0);
    if (totalMatches < minMatches) return raw; // already small

    const files = [...byFile.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );

    const out: string[] = [
      `${totalMatches} matches across ${byFile.size} files:`,
    ];
    for (const [path, matches] of files.slice(0, maxFilesShown)) {
      const header = matches.length > 1 ? `${path} (${matches.length})` : path;
      out.push(header);
      for (const m of matches.slice(0, maxMatchesPerFile)) {
        const text =
          m.text.length > maxLineChars
            ? m.text.slice(0, maxLineChars) + "…"
            : m.text;
        out.push(`  L${m.line}: ${text.trimStart()}`);
      }
      if (matches.length > maxMatchesPerFile) {
        out.push(`  ... +${matches.length - maxMatchesPerFile} more`);
      }
    }
    if (files.length > maxFilesShown) {
      const remaining = files.length - maxFilesShown;
      const remainMatches = files
        .slice(maxFilesShown)
        .reduce((a, b) => a + b[1].length, 0);
      out.push(`... and ${remaining} more files (${remainMatches} matches)`);
    }

    const result = out.join("\n");
    if (result.length >= raw.length) return raw;
    return result;
  },
};
