# QTK — Qalarc Token Killer

> Also a backronym for **Q**uantised **T**oken **K**iller — same idea, more descriptive.

**Deterministic token compression for OpenCode V1.**

> ## Read this first
>
> [**RTK (Rust Token Killer)**](https://github.com/rtk-ai/rtk) is the
> mature, production-grade project for deterministic token compression.
> 65k+ GitHub stars, 200+ releases, supports 14 AI coding tools across
> Linux/macOS/Windows, ships 100+ supported command filters. Built by
> Patrick Szymkowiak, Florian Bruniaux, Adrien Eppling and the RTK
> community. Licensed Apache-2.0.
>
> **If you're using Claude Code, Cursor, Gemini CLI, GitHub Copilot,
> Codex, Windsurf, Cline, Roo Code, OpenCode, OpenClaw, Pi, Hermes,
> Kilo Code, or Google Antigravity — use [RTK](https://rtk-ai.app).**
>
> **QTK is a narrow OpenCode V1-specific spiritual sibling.** It exists
> because OpenCode V1's plugin surface lets us hook `tool.execute.after`
> in-process for output handling, while RTK remains an optional external helper
> for Bash rewrites.
> That trade-off only makes sense if you're already committed to
> OpenCode V1. The whole project is downstream of RTK — RTK proved the
> thesis, ships the canonical filter corpus, and is broader and more
> battle-tested. See [`docs/RTK-COMPARISON.md`](docs/RTK-COMPARISON.md)
> for the architectural diff.

QTK is an [OpenCode V1](https://github.com/anomalyco/opencode) plugin that silently
compresses matching tool outputs (`git status`, `ls -la`, `rg`, `pytest`,
`cargo test`, `Read`/`Grep`/`Glob`, and optional sidecar-handled outputs such
as `kubectl get -o yaml`, `terraform plan`, and JUnit XML) **before they reach
the model's context window**. No LLM or prompt injection. RTK-first Bash
rewriting can change command input/history; see the permission caveat below.

<!-- TODO: insert a screenshot of the qtk gain output once we have a real session -->

```
Illustrative current-format report (fabricated values; not measured):
QTK · last 7 days · all projects (1) · 1 session
Tool output seen    100 calls · 64.0k tok
  compressed         20 calls · 40.0k → 32.0k tok   saved 8.0k (12.5% of all tool output)
  handled by RTK       5 calls · 2.0k tok out
  recovery calls       0 calls · 0 tok
  passed through     75 calls · 22.0k tok
    no compressor 12 · kept exact 63
Recalls             QTK 1 of 20 compressions (tee reads 1 · bypass reruns 0) · RTK 0 of 5 RTK calls
RTK totals          8 runs · saved 2.0k (20.0%) · RTK's own count, all time, all projects

By compressor                        calls   tok in → out   saved   recall
  git-status                            12     30.0k → 24.0k   6.0k     8.3%
  tool-grep                              8     10.0k → 8.0k    2.0k     0.0%
# USD appears only when `--usd` is supplied.
```

Startup logging is omitted from this report illustration. Sidecar compressors
are available only when the optional binary is installed.

When the calls table is unavailable, `qtk gain --json` reports the
compression-only history under `legacy_compressions`; it omits the funnel and
does not invent a call denominator or reason groups. `--db PATH` is read-only.

[![CI](https://github.com/qalarc/QTK/actions/workflows/ci.yml/badge.svg)](https://github.com/qalarc/QTK/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@qalarc/qtk-plugin?label=%40qalarc%2Fqtk-plugin)](https://www.npmjs.com/package/@qalarc/qtk-plugin)
[![tests](https://img.shields.io/badge/tests-182%20passing-brightgreen)](#tests)
[![bench](https://img.shields.io/badge/p99%20latency-%3C1.2ms-brightgreen)](#benchmarks)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![downstream of](https://img.shields.io/badge/downstream%20of-RTK-orange)](https://github.com/rtk-ai/rtk)

---

## Why this exists

A typical opencode "yolo" session burns **~120,000 tokens** of context on
mechanically-compressible tool output:

- `git status` porcelain (40+ lines for a typical work-in-progress)
- `ls -la` columns of `drwxr-xr-x 5 user group 4096 May 20 14:23 ...`
- `rg <pattern>` repeated `path:line:match` clusters
- `cargo test` "Compiling N crates" verbosity
- package-manager progress bars and dependency trees
- `kubectl get pods -o yaml` (multi-KB per pod, mostly `managedFields`)
- `terraform plan` showing 50 resources where 3 changed

**None of this needs an LLM to compress.** A few hundred lines of
hand-written parsers reduce these outputs by 60–99% with zero quality loss
for the model.

[RTK](https://github.com/rtk-ai/rtk) proved the thesis at scale with
100+ supported commands. QTK is the in-host version of the same idea:

| | RTK | QTK |
|---|---|---|
| **Where it lives** | External CLI binary | OpenCode V1 plugin, optionally using external RTK helper |
| **Hook surface** | Shell command wrapping | V1 before-hook routes Bash through RTK when present; after-hook processes outputs |
| **Default compressors** | Bash command filters | Bash outputs + `Read`/`Grep`/`Glob` and MCP text results |
| **Integration cost** | RTK command hint in agent instructions | No QTK prompt injection; RTK-first rewrites may appear in command history |
| **Per-call overhead** | Subprocess per invocation | In-process TS output path; RTK helper subprocess for Bash when enabled |
| **Heavy parsers** | Same Rust binary as everything | Optional `qtk-core` sidecar, fires only for XML/YAML/JSON |
| **Cross-call dedup** | None | Session cache: `<qtk-unchanged tool=bash since=14s_ago>` |
| **User filters** | PR upstream | `.opencode/qtk/filters/*.toml`, hot-reloaded |
| **Telemetry** | Opt-in, phones home | 100% local SQLite, zero network code |

RTK is the right answer for agents other than OpenCode V1. QTK targets the
OpenCode V1 plugin API; compatibility with forks is not claimed.

---

## Show me the numbers

```
Historical local microbenchmark (200 iterations per case; not live-session or current-host validation)

name                                            in     out   saved      p50      p90      p99
---------------------------------------------------------------------------------------------------
git status (recorded OpenCode tool output)      939     542   42.3%     17µs     31µs    110µs
git status (synthetic large, 100 files)       4.4k    1.3k   70.8%     55µs     93µs    178µs
rg (50 matches across 10 files)               3.6k    2.3k   36.6%     37µs     58µs    261µs
Read tool (500-line file)                    16.4k     206   98.7%    221µs    343µs   1.11ms
DSL: kubectl get pods (60 rows)               4.2k      73   98.2%    114µs    188µs   1.17ms
Glob (45 paths in 3 clusters)                 1.3k     360   73.1%     32µs     50µs    166µs
```

```
Historical qtk-core sidecar benchmark (Rust, NDJSON pipe; not current-host validation)

Cold start (spawn → hello → first compress): 2.4 ms ✅ (target ≤ 30 ms)

Throughput (serial, one client):
case                       in      out   saved      p50      p99      ops/s
--------------------------------------------------------------------------------
terraform-plan           3.3k      664   79.8%     64µs    739µs      10,102
kubectl-json             3.9k     1.4k   63.5%     95µs    848µs       7,721
cargo-json               5.0k      134   97.3%     56µs    748µs      11,316
junit-xml                2.8k      150   94.6%     43µs    729µs      13,732

Throughput (concurrent batches of 50):
  terraform-plan: 17,551 ops/s    cargo-json: 22,470 ops/s
  kubectl-json:   10,512 ops/s    junit-xml:  32,994 ops/s
```

---

## What QTK does, in 60 seconds

1. **OpenCode V1** prepares a model-executed tool call. For Bash, QTK invokes
   the external RTK helper first when it resolves; RTK suggestions are accepted
   by default. If RTK declines or is absent, QTK applies whitelist-safe quiet
   rewrites; verbosity/debug flags opt out.
2. **OpenCode V1** runs the tool; RTK may already have rewritten the command
   and compressed its output.
3. The `tool.execute.after` hook fires. QTK can inspect and rewrite normal
   opencode `output` strings and MCP text-content results before opencode
   flattens them for the model.
4. QTK looks up a matching compressor:
   - First: 4 optional async **sidecar compressors** (terraform plan, kubectl YAML/JSON, cargo JSON, JUnit XML) — these route to the Rust `qtk-core` subprocess. If the sidecar isn't available, they pass through.
   - Then: any **DSL filter** in `.opencode/qtk/filters/*.toml` matching the command.
   - Then: the **11 specific registered TS compressors** (`git-status`, `git-log`, `ls`, `find`, `rg`, `package-manager`, `pytest`, `cargo`, `Read`, `Grep`, `Glob`).
   - Last: `generic-text`, a lossless-by-default fallback for `task` and MCP tools with `_` in the name. It compacts valid JSON objects/arrays by removing whitespace outside strings, preserving values, number formatting, and key order; it applies only when at least `json_compact_min_saved_bytes` bytes are saved (default 256). Other output passes through unchanged. The result is marked `lossless=true` and has no tee because nothing needs recovery. Set `[qtk.compressors.generic_text] allow_lossy = true` to opt into the previous lossy summaries; those results are marked `lossy=true` and require a tee (otherwise they pass through unchanged).
5. The compressor runs (median ≪ 1 ms). Output is replaced with a compact form wrapped in a `<qtk-compressed ...>` envelope. Tee-backed compressions include a tee path; lossless results carry `lossless=true` and no tee.
6. For tee-backed compressions, recoverable output is saved to a tee file with mode `0o600`; contents follow `[qtk.redaction] enabled`.
7. Every processed after-hook call is recorded in a global SQLite database by default, attributed to project. `qtk gain` reports a tokens-first QTK funnel, with USD only when requested; RTK statistics have a separate scope. QTK tee reads and same-session `QTK_DISABLED=1` reruns are recall proxies, not proof that a particular compression caused a read. Tee reads pass through uncompressed; redaction follows `[qtk.redaction] enabled`.

**The model need not be taught about QTK.** No prompt injection. RTK-first Bash
rewriting changes command input/history, however, and OpenCode V1 permissions
are evaluated against the rewritten command; configure permission rules
accordingly. QTK quiet rewrites can be disabled with `QTK_REWRITE_DISABLED=1`
or globally with `QTK_DISABLED=1`.

---

## What's in here

### Phase 1/4: 12 registered TypeScript compressors

Hand-written, sub-100µs median latency:

- **`git status`** — porcelain → `branch=main (up to date with origin/main)\nstaged (3): modified foo.ts, modified bar.ts, new baz.ts\nunstaged (1): modified qux.ts`
- **`git log`** — multi-line commits → one-liners with `<hash> <date> <author>: <subject>`
- **`ls -la`** — long-format → sorted by type with size/mtime; falls back to grouped-by-extension for large flat listings
- **`find` / `fd`** — one-path-per-line results → grouped by containing directory
- **`rg`** / **`grep -r`** — `5 matches across 3 files:\n  src/foo.ts (3 matches)\n  L17: ...`
- **`npm` / `pnpm` / `bun` / `yarn`** — strips install/run progress, lifecycle echoes, and dependency-tree noise
- **`pytest`** — passing → just the summary; failing → keeps FAILED lines + first 8 trace lines
- **`cargo test`/`cargo build`/`cargo clippy`** — strips Compiling-noise, keeps errors
- **`Read` tool** — > 200 lines → signature outline (imports, function/class/interface/export lines)
- **`Grep` tool** — multi-file results → grouped by file, top match shown
- **`Glob` tool** — > 30 paths → clustered by 2-deep common directory prefix

### Phase 2: TOML filter DSL

Per-project compressors without writing TypeScript. Drop a file into `.opencode/qtk/filters/`:

```toml
# .opencode/qtk/filters/kubectl-pods.toml
command = "kubectl get pods"
strip = ["^NAME\\s+READY"]
match = "^(?<name>\\S+)\\s+(?<ready>\\d+/\\d+)\\s+(?<status>\\S+)\\s+(?<restarts>\\d+)\\s+(?<age>\\S+)$"
group_by = "status"
template = "{status}: {n} ({joined.name})"
header = "{matched} pods total"
truncate = 30
```

Pipeline: `pass_through_if → strip → dedupe → match → group_by → template → header/footer → truncate`. Regexes compiled at load time. Hot-reloaded with 250 ms debounce. Errors per-file isolated.

Also ships `scripts/import-rtk-filters.ts` to translate a local `git clone rtk-ai/rtk` into QTK format (strips RTK-only keys, adds attribution headers, validates against QTK's spec).

### Using QTK with RTK (hybrid)

QTK invokes RTK's `rtk rewrite` from its Bash before-hook when RTK is installed.
RTK suggestions are honored by default; QTK's Bash compressors remain the
fallback when RTK declines or is absent. Rewrites apply per shell segment:
allowed segments use RTK's result, denied segments keep the original, and
segment-count changes use the all-or-nothing policy. Agent-typed denied
`rtk <proxy>` commands are normalized before rewrite; RTK-native commands such
as `rtk read` and `rtk recall` are never stripped.

```toml
[qtk.rtk]
enabled = true              # auto-active only when the binary resolves
binary = "rtk"              # PATH name or absolute executable path
rewrite_timeout_ms = 1000   # bounded to 50–10000 ms
allow = ["*"]               # RTK owns all rewrites by default
deny = []                   # command prefixes QTK keeps for itself
```

`allow` and `deny` are token-prefix lists evaluated per command segment;
`deny` takes precedence. The default honors every rewrite RTK suggests. Add
families such as `"rg"` or `"git diff"` to `deny` when QTK should keep them.
RTK itself declines unsafe redirects, pipes into programs, and `--json`; QTK
honors those declines. RTK recall/proxy, `RTK_DISABLED=1`, and RTK tee-file
references are classified separately. QTK tee reads and bypass reruns are
recall proxies, not proof that a particular compression caused a read.

RTK ≥0.45 works; 0.49+ is recommended for SQLite recall and safer pipeline
rewriting. Do not install RTK's OpenCode plugin alongside QTK. **Permission
caveat:** OpenCode checks permissions against the rewritten `rtk …` command;
OpenCode V1 also persists that rewritten input in tool history, which agents
may imitate. A rule such as `"git push *": "ask"` will no longer match. Put commands
that must retain their permission gate in RTK `[hooks] exclude_commands`, or
add equivalent `"rtk git push *"` OpenCode rules. An RTK rewrite exit code 2
leaves the original command unchanged; QTK does not enforce RTK/Claude Code
deny decisions, and OpenCode permissions govern whether the command executes.

### Phase 3: Rust sidecar `qtk-core`

For heavy parsers where Rust's streaming parsers beat anything you'd write in JS:

- **JUnit XML** — quick-xml streaming, picks the first meaningful failure line per test, caps to 20 failures shown
- **Terraform plan** — regex-scan for resource headers, extracts the changed attributes for `~ updated in-place` resources
- **kubectl `get -o yaml`/`-o json`** — serde_json for JSON, conservative line-based pruning for YAML (drops `managedFields`, `resourceVersion`, etc.)
- **Cargo `--message-format=json`** — collapses N artifact lines into a count, promotes errors with `file:line:col`

NDJSON protocol over stdin/stdout (one JSON object per line). Long-lived subprocess per session. The TS client:
- Auto-restarts up to 3× on crash, then permanently disables
- Per-request 1-second timeout, falls back to the TS path on stall
- Lazy startup — first matching call awaits the binary; everything else passes through immediately
- **If the binary isn't installed, everything still works** — QTK silently uses TS-only

---

## Safety + privacy

- **No network code anywhere.** The Rust crate has no HTTP deps. The TS plugin has no HTTP deps. We literally cannot phone home.
- **Tee files are mode `0o600`, directory `0o700`.** Path-confined to the project root.
- **Secrets-aware redaction** on model-facing output and tee files follows `[qtk.redaction] enabled`: when enabled, common secrets are redacted before model mutation and disk write; when disabled, neither output is redacted.
- **`unsafe_code = "deny"`** in the Rust crate.
- **Circuit breaker:** any compressor that throws 3× in a session is automatically disabled for the rest of the session.
- **Length-monotonicity guard:** if a compressor ever produces output ≥ its input, the original is returned. Compression should never make things worse.
- **Compressor panic in Rust is caught** (`catch_unwind`) — turns into an error response, doesn't kill the sidecar.
- **Configured relative paths are project-rooted** — relative stats paths remain confined to the project; absolute `QTK_STATS_PATH` is the deliberate stats-only override.

---

## Install

### Quickest path — npm (recommended for most users)

```bash
cd /path/to/your/opencode-project
bun add @qalarc/qtk-plugin
```

Then add to `.opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "@qalarc/qtk-plugin"
  ]
}
```

Restart opencode. Done. For the optional Rust sidecar that handles heavy
parsers (JUnit XML, terraform plan, kubectl YAML/JSON, cargo JSON),
download the prebuilt binary for your platform from
[releases](https://github.com/qalarc/QTK/releases/latest) — the plugin
auto-detects it.

### Prebuilt binary release (no Rust toolchain needed)

```bash
QC=/path/to/your/opencode-project

# Plugin bundle (universal)
mkdir -p "$QC/.opencode/plugin"
curl -L -o "$QC/.opencode/plugin/qtk.js" \
    https://github.com/qalarc/QTK/releases/latest/download/qtk-plugin.js

# Optional: Rust sidecar binary (pick your platform)
# Linux x86_64:
curl -L -o "$QC/.opencode/plugin/qtk-core" \
    https://github.com/qalarc/QTK/releases/latest/download/qtk-core-x86_64-unknown-linux-musl
chmod +x "$QC/.opencode/plugin/qtk-core"

# Then add to .opencode/opencode.jsonc:
#    "plugin": [ ..., "file://.opencode/plugin/qtk.js" ]
```

### Build from source (for development)

```bash
# 1. Clone + build
git clone https://github.com/qalarc/QTK
cd QTK && bun install && bun run build

# 2. (Optional) Build the Rust sidecar
cd packages/qtk-core && cargo build --release && cd ../..

# 3. Use the one-shot installer to symlink into your opencode project
bun run scripts/install-into-opencode.ts /path/to/your/opencode-project
```

After install, check `[qtk] active — N compressors registered` in opencode's startup log. See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the full guide.

---

## Savings export format (dashboard consumer example)

This is the plugin's JSON export shape, not a claim that a live dashboard
integration or final-session measurement has been verified.

QTK writes a small JSON sidecar at `<project>/.opencode/qtk-savings.json`
every 10 seconds. The file looks like:

```json
{
  "schema": 2,
  "ts": 1716700000000,
  "session_id": "...",
  "totals": {
    "calls": 4872,
    "bytes_saved": 3838872,
    "tokens_saved": 805719,
    "usd_saved": 2.42,
    "model": "claude-sonnet-4-5",
    "pricing": {"inputUsdPer1M": 3.0, "outputUsdPer1M": 15.0}
  },
  "by_compressor": [
    {"name": "tool-read", "calls": 283, "tokens_saved": 217000, "bytes_saved": 1234567},
    ...
  ]
}
```

[**gmux**](https://github.com/fivelidz/gmux) (the gesture+voice terminal
multiplexer for fleets of AI agents) reads this file and surfaces
per-pane and per-session QTK savings:

- **tmux status bar:** `⊟ 855.7k $2.57` widget on the right
- **Phone PWA:** "⊟ QTK saved 217k tok · $0.65 (283 calls)" per agent card
- **gmuxtest Tauri UI:** Cost cell in the perf strip + per-pane HW section

Multiple gmux panes pointing at the same opencode instance are deduped
by port so you don't double-count.

Any other dashboard can read the same sidecar file. The current exporter
version is `schema: 2`; see `packages/qtk-plugin/src/savings-export.ts` for the
schema definition.

---

## Inspect what QTK is doing

```bash
bun run packages/qtk-plugin/src/cli/gain.ts

# Historical human-readable report sample (not current CLI output):
# Session b1c2d3 (3h 14m):
#   1,247 compression records
#   originally 4,512,309 bytes / 1,128,077 tokens
#   compressed  1,289,432 bytes /   322,358 tokens
#   tokens saved:     805,719 (-71.4%)
#
# Top 10 commands by tokens saved:
#   tool-read                    283   1.2M    312k   847k saved (-73%)
#   git-status                   147   294k     58k   234k saved (-79%)
#   sidecar:kubectl-structured    34   421k     94k   327k saved (-77%)
#   ...
# Example recall display only; recall counts are attribution proxies.
```

When a calls table exists, the report includes a tokens-first funnel; USD is
opt-in and RTK totals are separately scoped. Recall counts are attribution
proxies, not proof that a particular compression caused recovery. For a legacy
compression-only database, JSON reports `legacy_compressions`; it omits the
funnel and does not invent call denominators or reason groups. `--db PATH`
reads the selected database without migrating or modifying it.

In legacy human-readable mode the CLI labels these data “Legacy compressions”;
the sample above is not a rendering of that legacy output.

Stats are stored in the global `${XDG_DATA_HOME:-$HOME/.local/share}/qtk/stats.sqlite`
database by default. Set absolute `QTK_STATS_PATH` to override it, or use
`[qtk.stats] path` (absolute as-is, relative to and confined within the project).
`retention_days` defaults to 90; `0` keeps rows forever. The `calls` table
records every processed after-hook call and outcome; `compressions` retains
compression/cache-hit detail.

For live debugging, set `[qtk] log_level = "debug"` in `.opencode/qtk.toml`
or launch opencode with `QTK_DEBUG=1`. QTK logs compact per-call lines such as
`[qtk] compressed tool=bash ... bytes=2.2kB→733B saved=67.3%` to the plugin
process log; raw tool output is not logged.

See `docs/examples/qtk.toml` for the complete currently honored runtime config,
including global config (`~/.config/qtk/qtk.toml`), project overrides, disabling
Bash rewrites/sidecar/filters, opt-in lossy `generic-text` (`allow_lossy`), and
per-compressor caps. `[qtk.compression] min_savings_ratio` defaults to `0.10`
(bounded to `0`–`0.9`): QTK compares estimated tokens for the complete
model-facing envelope against the raw output and passes through raw text when
the configured saving is not reached.

---

## Architecture

```
opencode process
  └─ qtk-plugin (TypeScript)
      ├─ tool.execute.after hook
      ├─ Session cache (SHA-256 fingerprint, output-hash equality)
      │     → "<qtk-unchanged tool=bash since=14s_ago>"
       ├─ Async sidecar compressors
      │     ├─ matches() → bash command pattern
      │     └─ compress() → NDJSON over stdin/stdout to qtk-core
      │           ↓
      │     packages/qtk-core (Rust binary, optional)
      │       ├─ junit-xml      (quick-xml streaming)
      │       ├─ terraform-plan (regex-scan)
      │       ├─ kubectl-yaml   (line-pruner)
      │       ├─ kubectl-json   (serde_json)
      │       └─ cargo-json     (NDJSON serde_json)
       ├─ DSL filters
      │     ├─ Loaded from .opencode/qtk/filters/*.toml
      │     ├─ Hot-reloaded on file change (250ms debounce)
      │     └─ Pipeline: strip → dedupe → match → group_by → template → truncate
       ├─ Built-in TS compressors
      │     git-status, git-log, ls, find, rg, package-manager, pytest, cargo,
      │     tool-read, tool-grep, tool-glob
      ├─ Tee writer (.opencode/qtk-tee/<call-id>.log, 0o600)
       ├─ SQLite stats (~/.local/share/qtk/stats.sqlite by default)
      └─ Circuit breaker (auto-disables flaky compressor after 3 failures)
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design,
[`docs/RTK-COMPARISON.md`](docs/RTK-COMPARISON.md) for the detailed RTK
side-by-side, [`docs/RTK-PARITY-MATRIX.md`](docs/RTK-PARITY-MATRIX.md) for the
coverage roadmap, and [`docs/SECURITY.md`](docs/SECURITY.md) for the threat
model.

---

## Project layout

```
QTK/
├── README.md                       ← you are here
├── BRIEF.md                        ← original design brief
├── STATUS.md                       ← what's currently working
├── docs/
│   ├── ARCHITECTURE.md             ← internal design
│   ├── ROADMAP.md                  ← phase plan with current status
│   ├── RTK-COMPARISON.md           ← QTK vs RTK in detail
│   ├── SECURITY.md                 ← threat model + mitigations
│   ├── FILTER-DSL.md               ← TOML filter reference
│   └── INTEGRATION.md              ← installation guide
├── packages/
│   ├── qtk-plugin/                 ← Phase 1+2+3 TS plugin (73 KB bundle)
│   │   ├── src/
│   │   │   ├── index.ts            ← tool.execute.after hook
│   │   │   ├── compressors/        ← hand-written Bash command compressors
│   │   │   ├── tools/              ← built-in tool compressors
│   │   │   ├── dsl/                ← Phase 2: TOML filter DSL
│   │   │   ├── sidecar/            ← Phase 3: Rust subprocess client
│   │   │   └── cli/                ← `qtk gain` analytics
│   │   └── test/                   ← 171 TS tests
│   ├── qtk-core/                   ← Phase 3 Rust crate (1.98 MB binary)
│   │   ├── src/
│   │   │   ├── main.rs             ← NDJSON read loop
│   │   │   ├── protocol.rs         ← serde types
│   │   │   └── parsers/            ← 4 heavy parsers (22 Rust tests)
│   │   └── Cargo.toml
│   └── qtk-filters/imported/       ← RTK filter import target
├── scripts/
│   ├── install-into-opencode.ts    ← symlink + jsonc patcher
│   ├── benchmark.ts                ← TS compressor benchmark
│   ├── benchmark-sidecar.ts        ← Rust sidecar throughput benchmark
│   └── import-rtk-filters.ts       ← translate RTK corpus → QTK
└── LICENSE                         ← MIT
```

---

## Tests

```bash
bun test                          # 171 TS tests
cd packages/qtk-core && cargo test --release   # 22 Rust tests
# total: 193 passing, 0 failing
```

Coverage:

| Area                         | Tests | Notes                                                   |
| ---------------------------- | ----- | ------------------------------------------------------- |
| Phase 1/4 compressors        | 52    | Command/tool/generic compressors, fixtures, adversarial inputs |
| Session cache                | 3     | Fingerprint stability, hash check, LRU pruning          |
| Circuit breaker              | 2     | 3-strike disable, per-compressor isolation              |
| Secret redaction             | 13    | Model-facing + tee redaction follow `[qtk.redaction] enabled`, pass-through/compressed/MCP paths, false-positive guards |
| Phase 2 TOML DSL             | 39    | Parser, spec validator, runtime, loader, end-to-end     |
| Phase 3 Rust parsers         | 22    | All 4 parsers, malformed input, length-monotonicity     |
| Phase 3 sidecar integration  | 10    | Real binary spawn, hello, concurrent ids, stop/restart  |

---

## Benchmarks

```bash
bun run scripts/benchmark.ts             # TS compressors
bun run scripts/benchmark-sidecar.ts     # Rust sidecar (needs binary built)
```

See the "Show me the numbers" section above for current results.

---

## License

[MIT](LICENSE).

QTK's TOML filter DSL syntax is intentionally compatible with
[RTK's](https://github.com/rtk-ai/rtk) (Apache 2.0). RTK's filter corpus
can be imported via `scripts/import-rtk-filters.ts` with attribution
headers added per file. **No RTK source code is vendored** — QTK is a
clean-room implementation that shares only the user-facing TOML format.

---

## Acknowledgements

The entire QTK project is downstream of [RTK](https://github.com/rtk-ai/rtk).
RTK did the hard work of proving the deterministic-compression thesis at
scale and shipped a 100-filter corpus. QTK is what we want specifically
for opencode-based agents (where we can hook tools directly and don't
need an external CLI proxy); RTK is the right answer for everyone else.

Built on:
- [opencode](https://github.com/sst/opencode) — the agent host
- [@opencode-ai/plugin](https://www.npmjs.com/package/@opencode-ai/plugin) — plugin SDK
- [Bun](https://bun.sh) — TS runtime
- [quick-xml](https://crates.io/crates/quick-xml), [serde](https://serde.rs), [regex](https://crates.io/crates/regex) — Rust deps

Authored by [fivelidz](https://qalarc.com).
