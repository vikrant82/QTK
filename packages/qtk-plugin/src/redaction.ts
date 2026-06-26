// Global model-facing secret redaction.
//
// This pass is deliberately deterministic and local-only: no I/O, no network,
// no LLM, and compiled RegExps reused for all tool outputs. It runs at the
// final text boundary before QTK mutates opencode's tool result, so compressed
// and pass-through outputs share the same safety net.

const REDACTED_SECRET_VALUE = "[REDACTED_SECRET_VALUE]";

const SENSITIVE_ASSIGNMENT_NAME =
  "[A-Za-z0-9_]*(?:api[_-]?key|apikey|secret|password|passwd|pwd|token(?!izer)|credential|auth(?!(?:or\\b|ority))|private|access[_-]?key)[A-Za-z0-9_-]*";

const SECRET_PATTERNS_SOURCE: readonly string[] = [
  // Private key blocks before header-only matching.
  "-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
  // AWS access key ids.
  "AKIA[0-9A-Z]{16}",
  "ASIA[0-9A-Z]{16}",
  // GitHub tokens.
  "gh[pousr]_[A-Za-z0-9_]{20,}",
  "github_pat_[A-Za-z0-9_]{22,}",
  // AI/API provider keys.
  "sk-ant-[A-Za-z0-9-_]{20,}",
  "sk-(?:proj-)?[A-Za-z0-9_-]{20,}",
  "AIza[0-9A-Za-z-_]{35,}",
  // Payment and SaaS tokens.
  "sk_live_[0-9A-Za-z]{24,}",
  "rk_live_[0-9A-Za-z]{24,}",
  "xox[baprs]-[0-9A-Za-z-]{10,}",
  "SK[0-9a-fA-F]{32}",
  "SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}",
  "glpat-[A-Za-z0-9_-]{20,}",
  "npm_[A-Za-z0-9]{36,}",
  "pypi-[A-Za-z0-9]{20,}",
  "dckr_pat_[A-Za-z0-9_-]{20,}",
  "https://hooks\\.slack\\.com/services/[A-Za-z0-9/]{20,}",
  "https://[a-f0-9]{32}@[a-f0-9]{16}\\.ingest\\.sentry\\.io",
  // Auth headers, JWTs, connection strings, and private key headers.
  "Authorization\\s*:\\s*Bearer\\s+\\S{8,}",
  "(?:Authorization\\s*:\\s*)?Bearer\\s+[A-Za-z0-9\\-._~+/=]{20,}",
  "eyJ[A-Za-z0-9-_]+\\.eyJ[A-Za-z0-9-_]+\\.[A-Za-z0-9-_]+",
  "(?:mongodb|postgres|mysql|redis):\\/\\/[^\\s\"']{10,}",
  "-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
  "(?:datadog|DD)_(?:api_key|API_KEY)\\s*[=:]\\s*[\"']?[A-Za-z0-9]{32}[\"']?",
  "(?:datadog|DD)_(?:app_key|APP_KEY)\\s*[=:]\\s*[\"']?[A-Za-z0-9]{40}[\"']?",
  "(?:jfrog|JFROG)_(?:token|TOKEN)\\s*[=:]\\s*[\"']?[A-Za-z0-9]{20,}[\"']?",
  "(?:azure|AZURE)_(?:key|KEY)\\s*[=:]\\s*[\"']?[A-Za-z0-9=+/]{40,}[\"']?",
];

const COMPILED_SECRET_RE = new RegExp(SECRET_PATTERNS_SOURCE.join("|"), "gi");

const CATEGORY_PATTERNS: readonly [category: string, pattern: RegExp][] = [
  ["private-key", /PRIVATE KEY/i],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:gh[pousr]_|github_pat_)/i],
  ["ai-provider-key", /\b(?:sk-ant-|sk-(?:proj-)?|AIza)/],
  ["saas-token", /\b(?:sk_live_|rk_live_|xox[baprs]-|SG\.|glpat-|npm_|pypi-|dckr_pat_)/i],
  ["bearer-token", /(?:Authorization\s*:\s*)?Bearer\s+/i],
  ["jwt", /\beyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\./],
  ["connection-string", /\b(?:mongodb|postgres|mysql|redis):\/\//i],
];

const ASSIGNMENT_RE = new RegExp(
  `(^|[^.\\w-])(${SENSITIVE_ASSIGNMENT_NAME})(\\s*[=:]\\s*)(?:\"([^\"\\n]*)\"|'([^'\\n]*)'|([^\\s,\\]})]+))`,
  "gim",
);

export interface RedactionResult {
  readonly text: string;
  readonly count: number;
  readonly categories: readonly string[];
}

export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  const categories = new Set<string>();

  COMPILED_SECRET_RE.lastIndex = 0;
  const knownSecretRedacted = text.replace(COMPILED_SECRET_RE, (match) => {
    count++;
    categories.add(categoryForSecret(match));
    return REDACTED_SECRET_VALUE;
  });

  ASSIGNMENT_RE.lastIndex = 0;
  const assignmentRedacted = knownSecretRedacted.replace(
    ASSIGNMENT_RE,
    (match, prefix, name, separator, doubleQuoted, singleQuoted, bare) => {
      const value = (doubleQuoted ?? singleQuoted ?? bare ?? "") as string;
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
      if (!shouldRedactAssignmentValue(value, quote)) return match;
      count++;
      categories.add(quote ? "secret-literal" : "secret-assignment");
      return `${prefix}${name}${separator}${quote}${REDACTED_SECRET_VALUE}${quote}`;
    },
  );

  return { text: assignmentRedacted, count, categories: [...categories].sort() };
}

export function redactModelText(text: string): RedactionResult {
  const redacted = redactSecrets(text);
  if (redacted.count === 0) return redacted;
  const categoryAttr = redacted.categories.length > 0
    ? ` categories=${JSON.stringify(redacted.categories)}`
    : "";
  return {
    text: `<qtk-redacted count=${redacted.count}${categoryAttr}>\n${redacted.text}\n</qtk-redacted>`,
    count: redacted.count,
    categories: redacted.categories,
  };
}

function categoryForSecret(value: string): string {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(value)) return category;
  }
  return "secret-value";
}

function shouldRedactAssignmentValue(value: string, quote: string): boolean {
  if (!value || value.includes("REDACTED_SECRET_VALUE")) return false;
  if (quote) return value.length >= 4;
  if (looksLikeCodeIdentifier(value) && !/[0-9]/.test(value)) return false;
  if (value.length >= 32) return true;
  return value.length >= 20 && /[A-Za-z]/.test(value) && /[0-9=+/_.-]/.test(value);
}

function looksLikeCodeIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value);
}

export const _internal = {
  REDACTED_SECRET_VALUE,
  SECRET_PATTERNS_SOURCE,
};
