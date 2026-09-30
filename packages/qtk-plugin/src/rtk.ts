import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Resolve an RTK binary once during plugin initialization.
 * Absolute paths must identify an executable file; bare names use Bun's PATH
 * lookup. Resolution is read-only, stateless, safe for concurrent callers, and
 * returns null for every lookup failure.
 */
export function resolveRtkBinary(binary: string): string | null {
  try {
    if (isAbsolute(binary)) {
      accessSync(binary, constants.F_OK | constants.X_OK);
      return binary;
    }
    return Bun.which(binary) ?? null;
  } catch {
    return null;
  }
}

export type RtkRewriteResult =
  | { readonly kind: "rewrite"; readonly command: string }
  | { readonly kind: "decline" }
  | { readonly kind: "deny" };

export const DEFAULT_RTK_ALLOW = ["*"] as const;
export const DEFAULT_RTK_DENY: readonly string[] = [];

const RTK_NATIVE_COMMANDS = new Set([
  "read", "recall", "gain", "proxy", "json", "err", "test", "summary",
  "log", "env", "deps", "diff", "init", "config", "discover", "rewrite",
  "hook", "lint", "smart", "learn", "verify", "trust", "untrust",
  "cc-economics", "run", "telemetry", "session", "pipe", "hook-audit",
]);

const COMMAND_OPERATORS = ["&&", "||", "|&", ";", "|", "(", ")", "\n", "&"] as const;

/**
 * Split shell text into alternating command segments and exact control operators.
 * This deliberately is not a shell parser; matching the same lightweight boundaries
 * as RTK policy keeps per-segment routing pure and preserves original separators.
 */
export function splitCommandSegments(command: string): string[] {
  if (hasHereDocument(command)) return [command];
  const segments: string[] = [];
  let start = 0;
  let index = 0;
  let quote: "single" | "double" | null = null;
  let substitutionDepth = 0;
  let backtick = false;
  while (index < command.length) {
    const char = command[index]!;
    if (quote === "single") {
      if (char === "'") quote = null;
      index++;
      continue;
    }
    if (quote === "double") {
      if (char === "\\") { index += 2; continue; }
      if (char === '"') quote = null;
      index++;
      continue;
    }
    if (backtick) {
      if (char === "\\") { index += 2; continue; }
      if (char === "`") backtick = false;
      index++;
      continue;
    }
    if (char === "\\") { index += 2; continue; }
    if (char === "'") { quote = "single"; index++; continue; }
    if (char === '"') { quote = "double"; index++; continue; }
    if (char === "`") { backtick = true; index++; continue; }
    if (command.startsWith("$(", index)) { substitutionDepth++; index += 2; continue; }
    if (substitutionDepth > 0) {
      if (char === "(") substitutionDepth++;
      else if (char === ")") substitutionDepth--;
      index++;
      continue;
    }
    const operator = COMMAND_OPERATORS.find((candidate) => command.startsWith(candidate, index) &&
      !(candidate === "&" && (command[index - 1] === "<" || command[index + 1] === ">" || command[index + 1] === "&")) &&
      !(candidate === "|" && command[index + 1] === "&"));
    if (operator) {
      segments.push(command.slice(start, index), operator);
      index += operator.length;
      start = index;
    } else index++;
  }
  if (quote !== null || backtick || substitutionDepth !== 0) return [command];
  segments.push(command.slice(start));
  return segments;
}

function hasHereDocument(command: string): boolean {
  return /<<-?(?!<)\s*(?:'[^'\n]*'|"[^"\n]*"|[^\s;|&()<>]+)/.test(command);
}

/**
 * Apply an RTK rewrite by corresponding shell segment. Equal segment counts allow
 * denied/unallowed rewrites to retain the original segment; a count mismatch falls
 * back atomically. `deny` always wins over `allow` and matching is token-prefix based.
 */
export function applyRtkRewrite(
  original: string,
  rewritten: string,
  allow: readonly string[],
  deny: readonly string[],
): string {
  if (hasHereDocument(original) || hasHereDocument(rewritten)) return original;
  const before = splitCommandSegments(original);
  const after = splitCommandSegments(rewritten);
  if (!isBalancedCommand(original) || !isBalancedCommand(rewritten)) return original;
  if (before.length !== after.length) {
    const originalCommands = before.filter((part) => !isCommandOperator(part));
    const accepted = after.filter((part) => !isCommandOperator(part)).every((part) =>
      (isRtkCommand(part) && rtkRewriteAllowed(part, allow, deny)) ||
      originalCommands.some((prior) => prior.trim() === part.trim()),
    );
    return accepted ? rewritten : original;
  }
  return after.map((segment, index) => {
    if (isCommandOperator(segment)) return segment;
    return matchesCommandPolicy(segment, allow, deny) ? segment : before[index]!;
  }).join("");
}

/** Strip policy-rejected agent-typed RTK prefixes only for proxied external commands. */
export function normalizeAgentRtkCommand(command: string, allow: readonly string[], deny: readonly string[]): string {
  if (!isBalancedCommand(command) || hasHereDocument(command)) return command;
  return splitCommandSegments(command).map((segment) => {
    if (isCommandOperator(segment)) return segment;
    const tokens = rawCommandTokens(segment);
    if (tokens[0] !== "rtk" && !tokens[0]?.endsWith("/rtk")) return segment;
    const subcommand = tokens[1];
    if (!subcommand || RTK_NATIVE_COMMANDS.has(subcommand)) return segment;
    const policyCommand = tokens.slice(1).join(" ");
    const executable = subcommand.split("/").at(-1) ?? subcommand;
    const allowed = matchesCommandPolicy(policyCommand, allow, deny);
    const denied = matchesPrefix(policyCommand, deny);
    return !allowed || denied
      ? segment.replace(/^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)(?:\S*\/)?rtk\s+/, "$1")
      : executable === subcommand ? segment : segment.replace(subcommand, executable);
  }).join("");
}

/** Identify whether a Bash command requests RTK-owned recovery output. */
export function isRtkRecallCommand(command: string): boolean {
  return splitCommandSegments(command).some((segment) => {
    const tokens = rawCommandTokens(segment);
    return (tokens[0] === "rtk" || tokens[0]?.endsWith("/rtk") === true) &&
      (tokens[1] === "recall" || tokens[1] === "proxy");
  });
}

/** Identify arguments containing RTK's default tee location or its literal `$HOME` hint. */
export function referencesRtkTee(value: unknown, home: string, platform = process.platform, dataHome = process.env.XDG_DATA_HOME): boolean {
  const configuredDirectory = process.env.RTK_TEE_DIR;
  const dataBase = platform === "darwin"
    ? `${home}/Library/Application Support`
    : (dataHome || `${home}/.local/share`);
  const nativePath = `${dataBase}/rtk/tee`;
  const hintPaths = ["$HOME/Library/Application Support/rtk/tee", "$HOME/.local/share/rtk/tee"];
  const visit = (entry: unknown, depth: number): boolean => {
    if (typeof entry === "string") return entry.includes(nativePath) || hintPaths.some((hint) => entry.includes(hint)) ||
      (configuredDirectory !== undefined && entry.includes(configuredDirectory));
    if (depth >= 4 || entry === null || typeof entry !== "object") return false;
    return (Array.isArray(entry) ? entry : Object.values(entry)).some((child) => visit(child, depth + 1));
  };
  return visit(value, 0);
}

/**
 * Ask RTK to rewrite one complete shell command without invoking a shell.
 * The child is isolated to piped/ignored stdio and killed at the configured
 * deadline. Exit 0/3 with changed non-empty output rewrites; exit 2 reports a
 * denial without enforcing it (the host permission system governs execution).
 * Other exits, timeout, and errors decline. Concurrent invocations share no
 * mutable state.
 */
export async function rtkRewrite(opts: {
  binary: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<RtkRewriteResult> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([opts.binary, "rewrite", opts.command], {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
    });
    const stdout =
      typeof child.stdout === "object" && child.stdout !== null
        ? new Response(child.stdout).text()
        : Promise.resolve("");
    const result = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode, output: stdout })),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), opts.timeoutMs);
      }),
    ]);
    if (!result) {
      child.kill();
      return { kind: "decline" };
    }
    const output = (await result.output).trim();
    if (result.exitCode === 2) return { kind: "deny" };
    return (result.exitCode === 0 || result.exitCode === 3) && output && output !== opts.command
      ? { kind: "rewrite", command: output }
      : { kind: "decline" };
  } catch {
    child?.kill();
    return { kind: "decline" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Identify commands delegated to RTK so QTK does not rewrite them again.
 * This intentionally uses a lightweight shell-segment split rather than
 * parsing shell syntax; only the first word after env assignments matters.
 * It is pure and safe for concurrent callers.
 */
export function isRtkCommand(command: string): boolean {
  if (!isBalancedCommand(command)) return false;
  return getRtkSegments(command).length > 0;
}

/**
 * Check every RTK segment in a rewritten command, or every original segment
 * when checking a non-RTK command, against token-prefix allow entries; deny wins.
 * `*` explicitly allows all segments;
 * empty/invalid entries allow none. This parser is lightweight and pure.
 */
export function rtkRewriteAllowed(
  rewritten: string,
  allow: readonly string[],
  deny: readonly string[] = [],
): boolean {
  const segments = getRtkSegments(rewritten).map((tokens) => tokens.join(" "));
  const commands = segments.length > 0
    ? segments
    : splitCommandSegments(rewritten).filter((part) => !isCommandOperator(part) && commandTokens(part).length > 0);
  return commands.length > 0 && commands.every((segment) => matchesCommandPolicy(segment, allow, deny));
}

function isCommandOperator(part: string): boolean {
  return COMMAND_OPERATORS.includes(part as typeof COMMAND_OPERATORS[number]);
}

function isBalancedCommand(command: string): boolean {
  let quote: "single" | "double" | null = null;
  let backtick = false;
  let substitutionDepth = 0;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === "single") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === "\\") { index++; continue; }
      if (char === '"') quote = null;
      continue;
    }
    if (backtick) {
      if (char === "\\") { index++; continue; }
      if (char === "`") backtick = false;
      continue;
    }
    if (char === "\\") { index++; continue; }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else if (char === "`") backtick = true;
    else if (command.startsWith("$(", index)) { substitutionDepth++; index++; }
    else if (substitutionDepth > 0 && char === "(") substitutionDepth++;
    else if (substitutionDepth > 0 && char === ")") substitutionDepth--;
  }
  return quote === null && !backtick && substitutionDepth === 0;
}

function commandTokens(segment: string): string[] {
  let command = rawCommandTokens(segment);
  if (command[0] === "rtk" || command[0]?.endsWith("/rtk")) command = command.slice(1);
  return command;
}

function rawCommandTokens(segment: string): string[] {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let first = 0;
  while (first < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[first]!)) first++;
  return tokens.slice(first).map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function matchesCommandPolicy(segment: string, allow: readonly string[], deny: readonly string[]): boolean {
  const command = commandTokens(segment);
  if (command.length === 0) return false;
  return !matchesPrefix(segment, deny) && matchesPrefix(segment, allow);
}

function matchesPrefix(segment: string, entries: readonly string[]): boolean {
  const command = commandTokens(segment);
  return entries.some((entry) => {
    const prefix = entry.trim().split(/\s+/).filter(Boolean);
    return prefix.length > 0 && (prefix[0] === "*" ||
      (prefix.length <= command.length && prefix.every((token, index) => token === command[index])));
  });
}

function getRtkSegments(command: string): string[][] {
  return splitCommandSegments(command).filter((part) => !isCommandOperator(part)).flatMap((segment) => {
    const raw = segment.trim().split(/\s+/).filter(Boolean);
    let first = 0;
    while (first < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[first]!)) first++;
    const executable = raw[first]?.replace(/^['"]|['"]$/g, "");
    if (executable === "rtk" || executable?.endsWith("/rtk") === true) return [raw.slice(first + 1)];
    return [];
  });
}
