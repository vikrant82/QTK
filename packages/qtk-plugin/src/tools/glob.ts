// `Glob` tool compressor — opencode's Glob returns one path per line.
//
// For pattern matches that return many paths (e.g. `**/*.ts` in a large
// monorepo), we cluster by common directory prefix and show counts.

import type { Compressor, CompressorContext } from "../types.ts";
import { intOption, numberOption } from "../options.ts";

export const globToolCompressor: Compressor = {
  name: "tool-glob",
  category: "built-in-tool",

  matches(tool: string): boolean {
    return tool.toLowerCase() === "glob";
  },

  compress(raw: string, ctx: CompressorContext): string {
    if (!raw) return raw;

    const lines = raw.split("\n").filter((l) => l.length > 0);
    const clusterThreshold = intOption(ctx.config, "cluster_threshold", 30, {
      min: 1,
      max: 100_000,
    });
    if (lines.length < clusterThreshold) return raw;

    // Group paths by their top 2 directory components.
    // e.g. "packages/opencode/src/foo.ts" → cluster "packages/opencode/"
    // We pick a depth that produces a reasonable number of clusters.
    const byCluster = new Map<string, string[]>();

    // Try depth 2 first, then 3 if depth 2 produces too few clusters.
    const cluster = (path: string, depth: number): string => {
      const parts = path.split("/");
      if (parts.length <= depth) return parts.slice(0, -1).join("/") || ".";
      return parts.slice(0, depth).join("/");
    };

    for (const path of lines) {
      const key = cluster(path, 2);
      const arr = byCluster.get(key) ?? [];
      arr.push(path);
      byCluster.set(key, arr);
    }

    // If too many clusters at depth 2, the result will be just as messy
    // as the raw list. Bail out.
    const maxClusterRatio = numberOption(ctx.config, "max_cluster_ratio", 0.7, {
      min: 0.01,
      max: 1,
    });
    if (byCluster.size > lines.length * maxClusterRatio) return raw;

    const sorted = [...byCluster.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );

    const out: string[] = [
      `${lines.length} paths in ${byCluster.size} clusters:`,
    ];
    const maxClusters = intOption(ctx.config, "max_clusters", 15, {
      min: 1,
      max: 1000,
    });
    const samplePathsPerCluster = intOption(
      ctx.config,
      "sample_paths_per_cluster",
      2,
      { min: 0, max: 100 },
    );
    const maxExtensionsShown = intOption(ctx.config, "max_extensions_shown", 3, {
      min: 0,
      max: 50,
    });
    for (const [dir, paths] of sorted.slice(0, maxClusters)) {
      // Get unique extensions in this cluster
      const exts = new Set<string>();
      for (const p of paths) {
        const dot = p.lastIndexOf(".");
        if (dot > 0) exts.add(p.slice(dot));
      }
      const shownExts = [...exts].slice(0, maxExtensionsShown).join(", ");
      const extLabel =
        maxExtensionsShown > 0 && exts.size > 0
          ? ` [${shownExts}${exts.size > maxExtensionsShown ? ", ..." : ""}]`
          : "";

      out.push(`  ${dir}/  (${paths.length}${extLabel})`);
      // Show first 2 paths from each cluster as samples
      for (const p of paths.slice(0, samplePathsPerCluster)) {
        out.push(`    ${p}`);
      }
      if (paths.length > samplePathsPerCluster) {
        out.push(`    ... +${paths.length - samplePathsPerCluster} more`);
      }
    }
    if (sorted.length > maxClusters) {
      const remaining = sorted.length - maxClusters;
      const remPaths = sorted
        .slice(maxClusters)
        .reduce((a, b) => a + b[1].length, 0);
      out.push(`  ... and ${remaining} more clusters (${remPaths} paths)`);
    }

    const result = out.join("\n");
    if (result.length >= raw.length) return raw;
    return result;
  },
};
