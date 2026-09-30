# @qalarc/qtk-plugin

> opencode plugin for deterministic, in-process token compression of tool
> outputs. Downstream of [RTK (rtk-ai/rtk)](https://github.com/rtk-ai/rtk).

> Supported host contract: OpenCode V1 only. QTK is the single OpenCode
> plugin; RTK, if installed, is an external helper binary, not a second plugin.

[![npm](https://img.shields.io/npm/v/@qalarc/qtk-plugin)](https://www.npmjs.com/package/@qalarc/qtk-plugin)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/qalarc/QTK/blob/main/LICENSE)
[![downstream of](https://img.shields.io/badge/downstream%20of-RTK-orange)](https://github.com/rtk-ai/rtk)

This is the npm-publishable package containing the TypeScript opencode
plugin. The full project (including the Rust sidecar `qtk-core`, the
RTK filter import script, and all docs) lives at:

  **https://github.com/qalarc/QTK**

If you're not using opencode specifically, you almost certainly want
[RTK](https://github.com/rtk-ai/rtk) instead — RTK supports 14 AI
coding tools (Claude Code, Cursor, Gemini CLI, Copilot, OpenCode,
Codex, Windsurf, Cline, Roo Code, OpenClaw, Pi, Hermes, Kilo Code, and
Google Antigravity) and ships 100+ supported command filters.

## Install

```bash
cd /path/to/your/opencode-project
bun add @qalarc/qtk-plugin
```

Then register it in `.opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "@qalarc/qtk-plugin"
  ]
}
```

Restart opencode. You should see `[qtk] active — N compressors registered`.

## What it does

QTK hooks `tool.execute.after` in opencode and silently rewrites tool
outputs to a compact form before the model sees them. Typical
compression: 60-99% reduction on `git status`, `git log`, `ls -la`, `find`,
`fd`, `rg`, package-manager output, `pytest`, `cargo`, `Read`, `Grep`, `Glob`,
and recognizable MCP/task text shapes via the `generic-text` fallback. It is
lossless by default: valid JSON objects/arrays are compacted by removing only
whitespace outside strings, preserving values, number formatting, and key order,
and only when at least `json_compact_min_saved_bytes` bytes are saved (default
256). Other output passes through unchanged. Set
`[qtk.compressors.generic_text] allow_lossy = true` to enable the previous
lossy summaries; those require a tee and pass through unchanged if no tee can
be written.

Redaction is enabled by default. When `[qtk.redaction] enabled = true`, QTK
redacts common secrets such as
AWS keys, GitHub PATs, AI provider keys, bearer tokens, private keys, and
secret-like environment/config assignments. The same setting controls redaction
of tee files written for exact-output recovery. Assignment-like redactions preserve
the key/identifier and replace only the value with `[REDACTED_SECRET_VALUE]`
where possible.

It also has a conservative `tool.execute.before` hook for Bash-only quiet
rewrites such as `pytest -q`, `cargo --quiet`, `npm`/`pnpm install --silent`, and Gradle `--quiet --console=plain`.
Set `QTK_REWRITE_DISABLED=1` to disable only those rewrites, or put
`QTK_DISABLED=1` on an individual Bash command to bypass QTK for that exact tool
call.

### Using QTK with RTK (hybrid)

When RTK resolves, QTK invokes `rtk rewrite` before Bash execution and honors
RTK suggestions by default. QTK compressors remain fallback when RTK declines
or is absent. Defaults are `allow = ["*"]` and `deny = []`; deny token prefixes
win over allow and decisions apply per shell segment. Agent-entered denied
`rtk <proxy>` commands are normalized before rewrite, but RTK-native commands
are never stripped. RTK safety declines redirects, pipes into programs, and
`--json`. RTK recall/proxy, `RTK_DISABLED=1`, and RTK tee references are
tracked in a separately scoped RTK report. QTK tee reads and bypass reruns are
recall proxies, not proof that a particular compression caused a read.
RTK ≥0.45 works; 0.49+ is recommended. Do not also install RTK's OpenCode
plugin; QTK's integration makes it redundant. OpenCode permissions match the
rewritten command: use RTK `[hooks] exclude_commands` for commands requiring
their original permission rule, or add equivalent `rtk …` rules. RTK exit code
2 leaves the original command unchanged and suppresses QTK's quiet rewrite;
QTK does not enforce RTK/Claude Code denials, and OpenCode permissions govern
whether the command executes.
OpenCode V1 history also retains the rewritten command input, which agents may
imitate in later calls.

The default `[qtk.compression] min_savings_ratio` is `0.10`: QTK estimates
tokens for the complete model-facing envelope and passes raw text through unless
that saving is met. This estimate is not an exact tokenizer.

When a calls table is unavailable, `qtk gain --json` returns a
`legacy_compressions` summary only; it does not synthesize a calls funnel,
denominators, or reason groups. `--db PATH` reads legacy databases without
migrating or modifying them.

For live diagnostics, set `[qtk] log_level = "debug"` in `.opencode/qtk.toml`
or launch with `QTK_DEBUG=1`. Debug logs show per-call sizes, token estimates,
compressor names, pass-through reasons, and redaction counts without logging raw
tool output.

The package also loads bundled RTK-compatible TOML filters by default. For
per-project custom compressors or overrides, drop TOML files into
`.opencode/qtk/filters/`; project filters take precedence over bundled filters
and built-ins. The format is intentionally compatible with RTK's filter DSL.

For heavy parsers (JUnit XML, terraform plan, kubectl YAML/JSON, cargo
JSON), install the optional `qtk-core` Rust binary too. The plugin
auto-detects it; if missing, it just falls back to the TypeScript
compressors silently.

## Docs

- **Full README**: https://github.com/qalarc/QTK
- **Filter DSL reference**: https://github.com/qalarc/QTK/blob/main/docs/FILTER-DSL.md
- **Integration guide**: https://github.com/qalarc/QTK/blob/main/docs/INTEGRATION.md
- **vs RTK comparison**: https://github.com/qalarc/QTK/blob/main/docs/RTK-COMPARISON.md

## License

MIT.

QTK derives its TOML filter DSL from
[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) by
Patrick Szymkowiak, Florian Bruniaux, Adrien Eppling and the RTK
contributors. Apache-2.0. See the LICENSE file in this package for
the full attribution NOTICE.
