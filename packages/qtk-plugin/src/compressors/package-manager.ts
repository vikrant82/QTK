// npm / pnpm / bun / yarn output compressor.
//
// Package-manager output is mostly progress bars, lifecycle command echoes,
// funding/audit boilerplate, and repeated dependency tree rows. Keep errors and
// meaningful summaries, collapse deprecation/progress noise.

import type { Compressor } from "../types.ts";

const MAX_KEPT_LINES = 80;
const MAX_DEPRECATIONS = 8;
const MAX_DEPENDENCIES = 40;
const MAX_INPUT_BYTES = 500_000;

export const packageManagerCompressor: Compressor = {
  name: "package-manager",
  category: "package-manager",

  matches(tool: string, args: Record<string, unknown>): boolean {
    if (tool.toLowerCase() !== "bash") return false;
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (/[|&;><`]/.test(cmd)) return false;
    return matchesPackageManagerCommand(cmd);
  },

  compress(raw: string): string {
    if (!raw || raw.length < 200 || raw.length > MAX_INPUT_BYTES) return raw;

    const dependencyTree = compressDependencyTree(raw);
    if (dependencyTree) return dependencyTree;

    const lines = raw.split("\n");
    const kept: string[] = [];
    const deprecations: string[] = [];
    let progressLines = 0;
    let noticeLines = 0;
    let boilerplateLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isLifecycleEcho(trimmed)) {
        boilerplateLines++;
        continue;
      }
      if (isProgressLine(trimmed)) {
        progressLines++;
        continue;
      }
      if (isNoticeLine(trimmed)) {
        noticeLines++;
        continue;
      }
      const deprecated = deprecatedPackage(trimmed);
      if (deprecated) {
        if (deprecations.length < MAX_DEPRECATIONS) deprecations.push(deprecated);
        continue;
      }

      kept.push(trimLine(line));
    }

    const out: string[] = [];
    const removed = progressLines + noticeLines + boilerplateLines + deprecations.length;
    if (removed > 0) {
      const parts: string[] = [];
      if (progressLines) parts.push(`${progressLines} progress`);
      if (noticeLines) parts.push(`${noticeLines} notice`);
      if (boilerplateLines) parts.push(`${boilerplateLines} lifecycle`);
      if (deprecations.length) parts.push(`${deprecations.length} deprecation`);
      out.push(`package-manager: removed ${parts.join(", ")} line(s)`);
    }
    if (deprecations.length > 0) {
      out.push(`deprecated: ${deprecations.join(", ")}`);
    }

    const body = kept.slice(0, MAX_KEPT_LINES);
    out.push(...body);
    if (kept.length > MAX_KEPT_LINES) {
      out.push(`... +${kept.length - MAX_KEPT_LINES} more meaningful lines`);
    }

    const result = out.join("\n").trim();
    if (!result || result.length >= raw.length) return raw;
    return result;
  },
};

function matchesPackageManagerCommand(cmd: string): boolean {
  if (/^(npm|pnpm|yarn)\s+(install|i|ci|add|update|up|list|ls|outdated|audit|fund)\b/.test(cmd)) {
    return true;
  }
  if (/^bun\s+(install|add|update|outdated|pm\s+ls)\b/.test(cmd)) return true;
  if (/^pnpm\s+(dlx|exec)\s+(npm-check-updates|depcheck)\b/.test(cmd)) return true;
  // Keep package-manager wrappers away from test/build tool output until those
  // commands have dedicated compressors.
  return false;
}

function compressDependencyTree(raw: string): string | null {
  const lines = raw.split("\n");
  const deps: string[] = [];
  let sawTreeMarker = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      /[├└│─]/.test(trimmed) ||
      /^(dependencies|devDependencies|optionalDependencies):$/.test(trimmed)
    ) {
      sawTreeMarker = true;
    }
    const dep = extractDependency(trimmed);
    if (dep) deps.push(dep);
  }

  if (!sawTreeMarker || deps.length < 20) return null;
  const unique = [...new Set(deps)].sort((a, b) => a.localeCompare(b));
  const out: string[] = [`${unique.length} dependencies listed:`];
  for (const dep of unique.slice(0, MAX_DEPENDENCIES)) out.push(`  ${dep}`);
  if (unique.length > MAX_DEPENDENCIES) {
    out.push(`  ... +${unique.length - MAX_DEPENDENCIES} more`);
  }
  const result = out.join("\n");
  return result.length < raw.length ? result : null;
}

function extractDependency(line: string): string | null {
  const cleaned = line
    .replace(/[├└│─┬]/g, " ")
    .replace(/^\s*[+`'-]+\s*/, "")
    .trim();
  const atVersion = cleaned.match(
    /(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?@[\w.+~-][^\s]*)/,
  );
  if (atVersion && looksLikePackageVersion(atVersion[1]!)) return atVersion[1]!;
  const nameVersion = cleaned.match(
    /^(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)\s+([\w.+~-][^\s]*)$/,
  );
  if (nameVersion && looksLikeVersionValue(nameVersion[2]!)) {
    return `${nameVersion[1]}@${nameVersion[2]}`;
  }
  return null;
}

function looksLikePackageVersion(dep: string): boolean {
  const at = dep.lastIndexOf("@");
  if (at <= 0) return false;
  return looksLikeVersionValue(dep.slice(at + 1));
}

function looksLikeVersionValue(value: string): boolean {
  return /^(?:v?\d|workspace:|link:|file:|catalog:|npm:|patch:)/.test(value);
}

function isLifecycleEcho(line: string): boolean {
  return /^>\s+[^\s@]+@[^\s]+\s+/.test(line) || /^>\s+/.test(line);
}

function isProgressLine(line: string): boolean {
  return (
    /^Progress:\s/.test(line) ||
    /^Resolving:\s/.test(line) ||
    /^Downloading\s/.test(line) ||
    /^Downloaded\s/.test(line) ||
    /^Packages:\s/.test(line) ||
    /^\[[-=+#.>\s]+\]\s*\d+%/.test(line) ||
    /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)
  );
}

function isNoticeLine(line: string): boolean {
  return (
    /^npm notice\b/.test(line) ||
    /^npm fund\b/.test(line) ||
    /^\d+ packages? (?:are )?looking for funding/.test(line) ||
    /^Run `?npm fund`?/.test(line) ||
    /^Done in \d/.test(line) ||
    /^✨\s+Done in \d/.test(line)
  );
}

function deprecatedPackage(line: string): string | null {
  const npm = line.match(/^npm WARN deprecated\s+([^:]+):/);
  if (npm) return npm[1]!;
  const pnpm = line.match(/^WARN\s+deprecated\s+([^:]+):/);
  if (pnpm) return pnpm[1]!;
  return null;
}

function trimLine(line: string): string {
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}
