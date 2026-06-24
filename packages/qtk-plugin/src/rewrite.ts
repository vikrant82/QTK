// Safe pre-call command rewrites.
//
// These are intentionally conservative: Bash-only, whitelist-only, no shell
// compositions, and skipped whenever the user requested verbosity/debugging.

export interface RewriteResult {
  readonly command: string;
  readonly rule: string;
}

const VERBOSE_FLAGS = [
  "-v",
  "-s",
  "-vv",
  "-vvv",
  "--verbose",
  "--debug",
  "--trace",
  "--nocapture",
];

export function rewriteCommand(command: string): RewriteResult | null {
  const trimmed = command.trim();
  if (!trimmed || /[|&;><`]/.test(trimmed)) return null;
  if (hasVerboseIntent(trimmed)) return null;

  return (
    rewritePytest(trimmed) ??
    rewriteCargo(trimmed) ??
    rewritePackageInstall(trimmed)
  );
}

export function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function rewritePytest(command: string): RewriteResult | null {
  if (!/^pytest(?:\s|$)/.test(command)) return null;
  if (hasFlag(command, "-q") || hasFlag(command, "--quiet")) return null;
  return {
    command: insertAfterHead(command, "-q"),
    rule: "pytest-quiet",
  };
}

function rewriteCargo(command: string): RewriteResult | null {
  const match = command.match(/^cargo\s+(build|test|check|clippy)(?:\s|$)/);
  if (!match) return null;
  if (hasFlag(command, "--quiet") || hasFlag(command, "-q")) return null;
  return {
    command: insertAfterWords(command, 2, "--quiet"),
    rule: `cargo-${match[1]}-quiet`,
  };
}

function rewritePackageInstall(command: string): RewriteResult | null {
  const match = command.match(/^(npm|pnpm)\s+(install|i|ci)(?:\s|$)/);
  if (!match) return null;
  if (hasFlag(command, "--silent") || /\s--loglevel(?:\s|=)/.test(command)) {
    return null;
  }
  return {
    command: insertAfterWords(command, 2, "--silent"),
    rule: `${match[1]}-${match[2]}-silent`,
  };
}

function hasVerboseIntent(command: string): boolean {
  return VERBOSE_FLAGS.some((flag) => hasFlag(command, flag));
}

function hasFlag(command: string, flag: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(flag)}(\\s|$)`).test(command);
}

function insertAfterHead(command: string, inserted: string): string {
  return insertAfterWords(command, 1, inserted);
}

function insertAfterWords(command: string, wordCount: number, inserted: string): string {
  const words = command.split(/\s+/);
  words.splice(wordCount, 0, inserted);
  return words.join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
