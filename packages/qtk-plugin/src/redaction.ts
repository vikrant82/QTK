// Global model-facing secret redaction.
//
// This pass is deliberately deterministic and local-only: no I/O, no network,
// no LLM, and one compiled RegExp reused for all tool outputs. It runs at the
// final text boundary before QTK mutates opencode's tool result, so compressed
// and pass-through outputs share the same safety net.

const REDACTED = "[REDACTED]";

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
  // Common environment/config assignments.
  `${SENSITIVE_ASSIGNMENT_NAME}\\s*[=:]\\s*(?:\"[^\"\\n]{8,}\"|'[^'\\n]{8,}'|[^\\s\"'\`]{20,})`,
  "(?:datadog|DD)_(?:api_key|API_KEY)\\s*[=:]\\s*[\"']?[A-Za-z0-9]{32}[\"']?",
  "(?:datadog|DD)_(?:app_key|APP_KEY)\\s*[=:]\\s*[\"']?[A-Za-z0-9]{40}[\"']?",
  "(?:jfrog|JFROG)_(?:token|TOKEN)\\s*[=:]\\s*[\"']?[A-Za-z0-9]{20,}[\"']?",
  "(?:azure|AZURE)_(?:key|KEY)\\s*[=:]\\s*[\"']?[A-Za-z0-9=+/]{40,}[\"']?",
];

const COMPILED_SECRET_RE = new RegExp(SECRET_PATTERNS_SOURCE.join("|"), "gi");

export interface RedactionResult {
  readonly text: string;
  readonly count: number;
}

export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  COMPILED_SECRET_RE.lastIndex = 0;
  const redacted = text.replace(COMPILED_SECRET_RE, () => {
    count++;
    return REDACTED;
  });
  return { text: redacted, count };
}

export function redactModelText(text: string): RedactionResult {
  const redacted = redactSecrets(text);
  if (redacted.count === 0) return redacted;
  return {
    text: `<qtk-redacted count=${redacted.count}>\n${redacted.text}\n</qtk-redacted>`,
    count: redacted.count,
  };
}

export const _internal = {
  REDACTED,
  SECRET_PATTERNS_SOURCE,
};
