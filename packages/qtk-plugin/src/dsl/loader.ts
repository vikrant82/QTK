// Filter loader. Walks `.opencode/qtk/filters/*.toml`, parses + validates each
// file, returns an array of compiled Compressors.
//
// Errors are isolated per-file: a syntax error in one filter doesn't break
// the others. Errors are surfaced as warnings on stdout (matches the rest
// of QTK's logging convention).
//
// Path safety: filter files MUST live under `<projectRoot>/.opencode/qtk/filters/`.
// We refuse symlinks that point outside that directory.

import { dirname, resolve, join, relative, isAbsolute, sep } from "node:path";
import { readdir, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFilterToml } from "./parser.ts";
import { validateFilterSpec } from "./spec.ts";
import { compileFilter } from "./runtime.ts";
import { FilterParseError, type FilterSpec } from "./types.ts";
import type { Compressor } from "../types.ts";

export interface LoadedFilter {
  readonly spec: FilterSpec;
  readonly compressor: Compressor;
}

export interface LoadResult {
  readonly filters: readonly LoadedFilter[];
  readonly errors: readonly { source: string; error: string }[];
}

export interface FilterLoadOptions {
  /** Name prefix used for stats/provenance, e.g. `project` or `bundled`. */
  readonly namespace?: string;
}

/** Default filter directory relative to project root. */
export const DEFAULT_FILTER_DIR = ".opencode/qtk/filters";

/**
 * Load all filters from `<projectRoot>/<filterDir>/*.toml`.
 * Sorted in lexicographic order of filename (so `00-` prefix runs first).
 * Returns at most one filter per file; failed files are returned in `errors`.
 */
export async function loadFilters(
  projectRoot: string,
  filterDir: string = DEFAULT_FILTER_DIR,
  options: FilterLoadOptions = {},
): Promise<LoadResult> {
  const dir = isAbsolute(filterDir) ? filterDir : resolve(projectRoot, filterDir);
  let filterDirResolved: string;
  try {
    filterDirResolved = await realpath(dir);
  } catch {
    filterDirResolved = dir;
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { filters: [], errors: [] };
  }

  const tomlFiles = entries.filter((n) => n.endsWith(".toml")).sort();

  const filters: LoadedFilter[] = [];
  const errors: { source: string; error: string }[] = [];

  for (const name of tomlFiles) {
    const filePath = join(dir, name);
    let safeFilePath = filePath;

    // Path-confinement: refuse files that resolve outside the filter directory
    try {
      const realFile = await realpath(filePath);
      const relativeFile = relative(filterDirResolved, realFile);
      if (
        relativeFile === ".." ||
        relativeFile.startsWith(`..${sep}`) ||
        isAbsolute(relativeFile)
      ) {
        errors.push({
          source: filePath,
          error: `refusing filter that resolves outside filter directory: ${realFile}`,
        });
        continue;
      }
      const st = await stat(realFile);
      if (!st.isFile()) {
        errors.push({
          source: filePath,
          error: "not a regular file",
        });
        continue;
      }
      safeFilePath = realFile;
    } catch (e) {
      errors.push({ source: filePath, error: (e as Error).message });
      continue;
    }

    try {
      const text = await Bun.file(safeFilePath).text();
      const raw = parseFilterToml(text, filePath);
      const spec = validateFilterSpec(raw, filePath);
      const namespacedSpec = namespaceSpec(spec, options.namespace);
      if (!spec.enabled) continue;
      const compressor = compileFilter(namespacedSpec);
      filters.push({ spec: namespacedSpec, compressor });
    } catch (e) {
      const msg =
        e instanceof FilterParseError ? e.message : (e as Error).message;
      errors.push({ source: filePath, error: msg });
    }
  }

  return { filters, errors };
}

export async function loadBundledFilters(): Promise<LoadResult> {
  const dirs = bundledFilterDirs();
  if (dirs.length === 0) return { filters: [], errors: [] };

  const filters: LoadedFilter[] = [];
  const errors: { source: string; error: string }[] = [];
  for (const dir of dirs) {
    const result = await loadFilters("/", dir, { namespace: "bundled" });
    filters.push(...result.filters);
    errors.push(...result.errors);
  }
  return { filters, errors };
}

export function bundledFilterDirs(): readonly string[] {
  const existing = candidateBundledFilterDirs().find((d) => existsSync(d));
  return existing ? [existing] : [];
}

function candidateBundledFilterDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    // Published package layout: files are copied into qtk-plugin/filters/imported.
    resolve(here, "..", "..", "filters", "imported"),
    // Development source layout: packages/qtk-plugin/src/dsl -> packages/qtk-filters.
    resolve(here, "..", "..", "..", "qtk-filters", "imported"),
    // Bundled dist layout: qtk-plugin/dist/index.js -> qtk-plugin/filters/imported.
    resolve(here, "..", "filters", "imported"),
    // Development dist layout: qtk-plugin/dist -> packages/qtk-filters.
    resolve(here, "..", "..", "qtk-filters", "imported"),
  ];
}

function namespaceSpec(spec: FilterSpec, namespace?: string): FilterSpec {
  if (!namespace) return spec;
  return { ...spec, name: `${namespace}:${spec.name}` };
}
