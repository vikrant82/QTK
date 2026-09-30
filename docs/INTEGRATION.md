# Integrating QTK with OpenCode V1

> Step-by-step guide for OpenCode V1 only. Fork compatibility is not claimed.
> QTK is the single installed OpenCode plugin; RTK, if installed, is an
> external helper binary called by QTK, not a second OpenCode plugin.

---

## Prerequisites

- Bun ≥ 1.3.5 (`bun --version`)
- OpenCode V1 (QTK does not claim V2 or fork compatibility)
- A QTK checkout

## Using QTK with RTK (hybrid)

QTK calls `rtk rewrite` in its Bash before-hook whenever RTK is installed and
honors RTK suggestions by default. QTK compressors remain fallback when RTK
declines or is unavailable. Decisions apply per shell segment; denied segments
retain original text, while segmentation-count mismatches use all-or-nothing
policy. Agent-entered denied `rtk <proxy>` prefixes are stripped before rewrite,
but RTK-native subcommands remain intact.

Configure `.opencode/qtk.toml`:

```toml
[qtk.rtk]
enabled = true
binary = "rtk"              # PATH name or absolute executable path
rewrite_timeout_ms = 1000   # 50–10000 ms
allow = ["*"]
deny = []
```

`allow`/`deny` use token prefixes per segment; deny takes precedence. Add
families such as `"rg"` or `"git diff"` to `deny` for QTK to retain. RTK itself
declines redirects, pipes into programs, and `--json`; QTK honors these safety
declines. `rtk recall`/`proxy`, `RTK_DISABLED=1`, and RTK tee references are
classified separately in call stats. Tee references, tee reads and bypass
reruns are recall proxies, not proof a particular compression caused recovery.

`enabled = true` is automatic: RTK coordination activates only if the binary
resolves. RTK ≥0.45 works; 0.49+ is recommended for SQLite recall and safer
pipeline rewriting. Do not install RTK's own OpenCode plugin alongside this
integration. **Permission caveat:** OpenCode evaluates Bash permissions after the
before-hook, against the rewritten `rtk …` command. Thus a rule such as
`"git push *": "ask"` no longer matches. Exclude such commands in RTK's
`[hooks] exclude_commands`, or add matching rules for `"rtk git push *"`.
OpenCode V1 also persists the rewritten command input in tool history; agents
may imitate the visible `rtk …` command in later calls. QTK only normalizes
denied/unallowed proxy commands, not RTK-native commands.
If RTK returns exit code 2, QTK leaves the original command unchanged and does
not apply a QTK quiet rewrite. QTK does not enforce RTK/Claude Code denials;
OpenCode permissions govern whether the command executes.

In the snippets below, replace `$QTK` with the path to your QTK checkout and
`$OC` with the path to your opencode project root (the directory containing
`.opencode/`).

---

## Install method 1 — npm (recommended for most users)

The QTK plugin is published to npm as
[`@qalarc/qtk-plugin`](https://www.npmjs.com/package/@qalarc/qtk-plugin).
This is the quickest install path and the one you should use unless you
have a specific reason not to.

```bash
cd "$OC"
bun add @qalarc/qtk-plugin
# or: npm install @qalarc/qtk-plugin
# or: pnpm add @qalarc/qtk-plugin
```

Then add to `.opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "@qalarc/qtk-plugin"
  ]
}
```

Restart opencode. For the optional Rust sidecar, see Install method 2 below.

To upgrade: `bun update @qalarc/qtk-plugin` (picks up the latest 0.x release).

## Install method 2 — prebuilt release artifact

If you don't want a Node-style package install, drop the prebuilt files
directly into your opencode project's plugin directory. This is what we
recommend for the optional Rust sidecar regardless of how you installed
the plugin.

```bash
# Plugin bundle (universal — any OS, any arch)
mkdir -p "$OC/.opencode/plugin"
curl -L -o "$OC/.opencode/plugin/qtk.js" \
    https://github.com/qalarc/QTK/releases/latest/download/qtk-plugin.js

# Optional: Rust sidecar binary (pick your platform)
case "$(uname -sm)" in
  "Linux x86_64")  ARTIFACT=qtk-core-x86_64-unknown-linux-musl ;;
  "Linux aarch64") ARTIFACT=qtk-core-aarch64-unknown-linux-musl ;;
  "Darwin x86_64") ARTIFACT=qtk-core-x86_64-apple-darwin ;;
  "Darwin arm64")  ARTIFACT=qtk-core-aarch64-apple-darwin ;;
esac
curl -L -o "$OC/.opencode/plugin/qtk-core" \
    https://github.com/qalarc/QTK/releases/latest/download/$ARTIFACT
chmod +x "$OC/.opencode/plugin/qtk-core"

# Then register in opencode.jsonc:
#   "plugin": [ ..., "file://.opencode/plugin/qtk.js" ]
```

If you installed via npm (method 1), you don't need to copy `qtk.js` —
opencode picks it up from `node_modules`. You only need the sidecar
binary download in that case.

## Install method 3 — automated installer (build from source)

A convenience script lives at `scripts/install-into-opencode.ts`. Pass
the path to your opencode project root:

```bash
cd "$QTK"
bun run scripts/install-into-opencode.ts "$OC"

# To remove:
bun run scripts/install-into-opencode.ts "$OC" --uninstall
```

The script symlinks the plugin and patches `.opencode/opencode.jsonc`
(creating a `.bak` first). Recommended for active QTK development where
you want changes to QTK's source picked up on the next session start.

## Install method 4 — source-mode plugin (for QTK contributors)

Same as method 3 but manual, useful if you don't trust automated config
edits or want to understand the moving parts.

```bash
# 1. No build/prebuild is required for local source mode.
cd "$QTK"

# 2. Symlink into opencode's plugin directory
mkdir -p "$OC/.opencode/plugin"
ln -sfn "$QTK/packages/qtk-plugin" "$OC/.opencode/plugin/qtk"

# 3. Register in opencode.jsonc — add to the "plugin" array:
#       "file:///absolute/path/to/QTK/packages/qtk-plugin/src/index.ts"

# 4. Restart opencode
```

---

## Verifying the install

After restart, open a fresh opencode session and check the startup output.
You should see:

```
[qtk] active — N compressors registered
[qtk] compressors: tool-read, tool-grep, tool-glob, git-status, git-log, ls, find, rg, package-manager, pytest, cargo, ...
```

If you see a load error instead, check:

- `.opencode/plugin/qtk` symlink target exists and is readable
- The plugin entry points to the intended source file in source mode, or package/bundle entry for npm/dist installs
- `opencode.jsonc` has the plugin path correctly listed

---

## Verifying compression works

In the new session, ask the agent to run any of these and watch the
response size:

```
git status
ls -la
rg useEffect packages/
```

Then inspect the stats DB directly:

```bash
sqlite3 "${QTK_STATS_PATH:-${XDG_DATA_HOME:-$HOME/.local/share}/qtk/stats.sqlite}" \
  "SELECT tool, compressor, original_bytes, compressed_bytes,
          ROUND(ratio, 2) AS ratio
   FROM compressions
   ORDER BY ts DESC
   LIMIT 20;"
```

The shared database defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/qtk/stats.sqlite`.
Absolute `QTK_STATS_PATH` overrides it; `[qtk.stats] path` supports absolute or
project-relative confined paths. `retention_days` defaults to 90 (`0` keeps
rows forever). The `calls` table logs every processed hook, including
passthrough reasons (`small`, `kept_exact`, `no_compressor`, `fail_open`,
`not_worth_it`, `no_tee`, `excluded`, `error`); `compressions` holds
compressor/cache-hit details. `kept_exact` identifies unchanged default-lossless
`generic-text` output, while a below-threshold Read result is categorized as
`small`; `fail_open` remains for compressor declines/parse failures and output
that did not shrink.

Or via the CLI:

```bash
bun "$QTK/packages/qtk-plugin/src/cli/gain.ts"
```

For live per-call diagnostics, enable debug logging with either config or env:

```toml
[qtk]
log_level = "debug"
```

or:

```bash
QTK_DEBUG=1 opencode
```

Debug lines are written to the opencode/plugin process log, never to model
tool output. They contain sizes, token estimates, compressor names, pass-through
reasons, and redaction counts, but not raw tool output:

```text
[qtk] compressed tool=bash cmd="git status" shape=output compressor=git-status bytes=2.2kB→733B saved=67.3% tok=561→184 dt=1ms
[qtk] passthrough tool=serena_find_symbol shape=mcp_text_content reason=no_match bytes=18.4kB tok=4700
[qtk] redacted tool=read shape=output bytes=480B→421B redactions=2
```

---

## Configuration

QTK loads a global config first, then merges project config over it:

- Global: `~/.config/qtk/qtk.toml` or `$XDG_CONFIG_HOME/qtk/qtk.toml`
- Project: `<opencode project>/.opencode/qtk.toml`

See `docs/examples/qtk.toml` for a complete copy-pasteable sample of every
currently honored runtime knob.

```toml
[qtk]
enabled = true
log_level = "info" # set to "debug" for per-call compression diagnostics
dedup_ttl_seconds = 60

[qtk.compression]
min_input_bytes = 200
min_savings_ratio = 0.10 # estimated-token savings after the full QTK envelope

[qtk.rewrite]
enabled = true # set false to disable Bash quiet rewrites

[qtk.redaction]
enabled = true # controls redaction of model-facing output and tee files

[qtk.sidecar]
enabled = true # set false to skip qtk-core lookup/use
request_timeout_ms = 1000
disabled = [] # e.g. ["sidecar:junit-xml"]

[qtk.tee]
enabled = true
mode = "failures_and_compressed"
prune_days = 7

[qtk.filters]
bundled = true
project = true
disabled = [] # e.g. ["project:noisy", "dsl:bundled:helm"]

[qtk.compressors.git_status]
enabled = true # set false to disable this built-in compressor
max_files_per_section = 15

[qtk.compressors.generic_text]
enabled = true # lossless JSON compaction by default for MCP/task fallback
json_compact_min_saved_bytes = 256
allow_lossy = false # opt in to lossy summaries; these require a tee
disabled_shapes = [] # json | diagnostics | path_list | markdown | repeated_lines

[qtk.tools.read]
enabled = true # maps to internal compressor name tool-read
outline_threshold_lines = 200
```

By default, this fallback compacts valid JSON objects/arrays only by removing
whitespace outside string literals; values, number formatting, and key order
are preserved. It applies only when the configured minimum saving is reached
(256 bytes by default); all other output passes through unchanged. Results are
marked `lossless=true` and are not teed. Set `allow_lossy = true` to enable the
previous summaries, which are marked `lossy=true` and pass through unchanged
if a tee cannot be written.

When a calls table exists, `qtk gain` reports a tokens-first funnel; USD is
opt-in and RTK totals are separately scoped. QTK tee reads and bypass reruns
are recall proxies, not proof of causal recovery. Legacy compression-only
databases produce `legacy_compressions` JSON and omit the funnel, invented call
denominators, and reason groups; `--db PATH` reads without migration or writes.
A read of a QTK tee file passes through uncompressed (redaction
applies when `[qtk.redaction] enabled` is true) and flags its originating
compression. A Bash rerun with
`QTK_DISABLED=1` of a command compressed in the same session within 15 minutes
also flags the originating compression.

The config loader currently supports booleans, numbers, strings, arrays, and
section tables. Project config overrides global config; per-compressor/per-tool
tables are deep-merged by table name.

The default `min_savings_ratio = 0.10` compares estimated tokens for the
complete model-facing envelope with the raw output; if savings are below the
configured threshold, QTK passes the original through. `qtk gain` is
tokens-first, USD is opt-in, and RTK statistics are separately scoped.

For adding custom per-project compressors as TOML filters in
`.opencode/qtk/filters/`, see `docs/FILTER-DSL.md` and
`docs/examples/filter.toml`.

---

## Coexistence with RTK

QTK alone is registered as the OpenCode plugin. Its V1 before-hook calls the
external RTK helper first when available; RTK suggestions are accepted by
default (`allow=["*"]`, `deny=[]`). QTK handles outputs afterward. Do not add
RTK's OpenCode plugin as a second integration.

When the agent writes `git status`:

1. QTK invokes external `rtk rewrite`, which may turn the request into
   `rtk git status`; OpenCode history retains the rewritten command.
2. OpenCode permissions apply to the rewritten command. Bash runs the
   resulting `rtk git status`; RTK may produce compact output.
3. QTK's after-hook skips the already-compact RTK output.
4. The model sees the compact form.

For a command such as `cat src/foo.ts`, RTK may rewrite it to `rtk read`; do not
assume a particular installed RTK mapping. If RTK rewrites it, QTK stands down
from re-compressing that RTK output. Otherwise QTK may apply a matching fallback;
generic-text compacts eligible JSON losslessly by default, with other generic
summaries opt-in via `allow_lossy = true`. Unmatched output passes through.

So even with RTK, QTK catches what RTK misses — particularly built-in tools
(`Read`/`Grep`/`Glob`), which RTK can't reach at all.

---

## Compatibility with local Ollama / vLLM models

QTK is provider-agnostic — it compresses tool outputs the same way regardless
of which model the agent is using. Local Qwen, Llama, Claude Sonnet, GPT-4 —
all see the same compressed outputs.

In fact QTK is **more valuable** for local models because:

- Local models have shorter effective context windows
- Local models pay no monetary cost per token but pay heavily in latency
  and VRAM for long contexts
- Compressing tool outputs lets local models keep more conversation history
  in the same VRAM budget

---

## Uninstalling

```bash
# Remove the symlink/file
rm "$OC/.opencode/plugin/qtk"
# or
rm "$OC/.opencode/plugin/qtk.js"

# Remove from opencode.jsonc plugin array

# Optional: remove the cache/stats files
rm -rf "$OC/.opencode/qtk-tee/"
rm "${QTK_STATS_PATH:-${XDG_DATA_HOME:-$HOME/.local/share}/qtk/stats.sqlite}"

# Restart opencode — no QTK
```

---

## Troubleshooting

| Symptom                                 | Likely cause                            | Fix                                                            |
| --------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `[qtk] active` never appears on startup | Plugin not registered in opencode.jsonc | Check the `plugin` array includes the file:// path             |
| Plugin loads but no compression happens | Compressor matches not triggering       | Check the global `qtk/stats.sqlite` — empty? Compressor names wrong? |
| Stats DB has entries but ratio is 1.0   | Compressor returning input unchanged    | Likely raw output already short, or compressor has a bug       |
| `qtk-tee/` files are world-readable     | OS umask interfering                    | Open issue — files are written with explicit `mode: 0o600`     |
| Latency spikes per tool call > 50 ms    | Compressor regex backtracking           | Identify offending compressor in stats `duration_ms`, file bug |
| QTK disabled itself mid-session         | Circuit breaker triggered               | Check stderr for which compressor failed 3×; file bug          |
| Memory growing during long session      | Cache LRU not pruning                   | Restart session, file bug — cache should cap at 500 entries    |
