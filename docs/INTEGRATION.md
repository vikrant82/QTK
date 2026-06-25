# Integrating QTK with opencode

> Step-by-step guide to installing QTK into any opencode-based agent
> (stock [opencode](https://github.com/sst/opencode) ≥ 1.1.21, or compatible
> forks). QTK ships as a plain opencode plugin — no patching of the host.

---

## Prerequisites

- Bun ≥ 1.3.5 (`bun --version`)
- opencode ≥ 1.1.21 (or a fork that loads `@opencode-ai/plugin`-compatible plugins)
- A QTK checkout

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

## Install method 4 — symlink (for QTK contributors)

Same as method 3 but manual, useful if you don't trust automated config
edits or want to understand the moving parts.

```bash
# 1. Build qtk-plugin (creates dist/index.js)
cd "$QTK"
bun install
bun run build

# 2. Symlink into opencode's plugin directory
mkdir -p "$OC/.opencode/plugin"
ln -sfn "$QTK/packages/qtk-plugin" "$OC/.opencode/plugin/qtk"

# 3. Register in opencode.jsonc — add to the "plugin" array:
#       "file://.opencode/plugin/qtk/src/index.ts"

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
- `dist/index.js` exists (run `bun run build` in QTK)
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
sqlite3 "$OC/.opencode/qtk-stats.sqlite" \
  "SELECT tool, compressor, original_bytes, compressed_bytes,
          ROUND(ratio, 2) AS ratio
   FROM compressions
   ORDER BY ts DESC
   LIMIT 20;"
```

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

[qtk.rewrite]
enabled = true # set false to disable Bash quiet rewrites

[qtk.redaction]
enabled = true # model-facing redaction; tee files still redact on write

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
enabled = true # lossy MCP/task fallback; disable if too aggressive
disabled_shapes = [] # json | diagnostics | path_list | markdown | repeated_lines

[qtk.tools.read]
enabled = true # maps to internal compressor name tool-read
outline_threshold_lines = 200
```

The config loader currently supports booleans, numbers, strings, arrays, and
section tables. Project config overrides global config; per-compressor/per-tool
tables are deep-merged by table name.

For adding custom per-project compressors as TOML filters in
`.opencode/qtk/filters/`, see `docs/FILTER-DSL.md` and
`docs/examples/filter.toml`.

---

## Coexistence with RTK

If you have [RTK](https://github.com/rtk-ai/rtk) installed already (as
`~/.local/bin/rtk` + the OpenCode plugin at `.opencode/plugin/rtk.ts`),
QTK is additive. The order of plugins in `opencode.jsonc` matters:

```jsonc
{
  "plugin": [
    "file://.opencode/plugin/rtk.ts", // RTK rewrites commands (before)
    "file://.opencode/plugin/qtk", // QTK compresses outputs (after)
  ],
}
```

RTK runs on `tool.execute.before` and rewrites bash commands. QTK runs on
`tool.execute.after` and compresses what comes back. No conflict.

When the agent writes `git status`:

1. RTK turns it into `rtk git status`
2. Bash runs `rtk git status` — RTK's internal git filter produces compact output
3. QTK's git compressor sees the already-compact output, skips
4. Model sees the small compact form

When the agent writes `cat src/foo.ts`:

1. RTK has no rewrite rule for `cat <file>`, passes through
2. Bash runs `cat src/foo.ts` — raw file contents
3. QTK's generic file-content compressor truncates/outlines if large
4. Model sees the compressed form

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
rm "$OC/.opencode/qtk-stats.sqlite"

# Restart opencode — no QTK
```

---

## Troubleshooting

| Symptom                                 | Likely cause                            | Fix                                                            |
| --------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `[qtk] active` never appears on startup | Plugin not registered in opencode.jsonc | Check the `plugin` array includes the file:// path             |
| Plugin loads but no compression happens | Compressor matches not triggering       | Check `qtk-stats.sqlite` — empty? Compressor names wrong?      |
| Stats DB has entries but ratio is 1.0   | Compressor returning input unchanged    | Likely raw output already short, or compressor has a bug       |
| `qtk-tee/` files are world-readable     | OS umask interfering                    | Open issue — files are written with explicit `mode: 0o600`     |
| Latency spikes per tool call > 50 ms    | Compressor regex backtracking           | Identify offending compressor in stats `duration_ms`, file bug |
| QTK disabled itself mid-session         | Circuit breaker triggered               | Check stderr for which compressor failed 3×; file bug          |
| Memory growing during long session      | Cache LRU not pruning                   | Restart session, file bug — cache should cap at 500 entries    |
