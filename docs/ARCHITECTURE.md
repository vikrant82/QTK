# QTK Architecture

> How QTK actually works inside opencode. The brief
> ([`BRIEF.md`](../BRIEF.md)) is the _what_ and _why_. This is the _how_.

---

## 1. OpenCode V1 tool-call lifecycle

QTK currently targets OpenCode V1 only. It is the single installed OpenCode
plugin; RTK, when available, is an external helper binary invoked by QTK, not a
second OpenCode plugin. Compatibility with forks is not claimed.

Model-executed registered tools in current opencode (`Bash`, `Read`, `Grep`,
`Glob`, `Task`, and MCP tools) flow through the tool resolver in
`packages/opencode/src/session/tools.ts`:

```ts
async execute(args, options) {
  await Plugin.trigger(
    "tool.execute.before",
    { tool: item.id, sessionID, callID: options.toolCallId, args },
    { args },
  )

  const result = await item.execute(args, { ... })   // ← the actual tool

  await Plugin.trigger(
    "tool.execute.after",
    { tool: item.id, sessionID, callID: options.toolCallId, args },
    result,                                          // ← QTK mutates this
  )
  return result
},
toModelOutput(result) {
  return { type: "text", value: result.output }     // ← normal tools
}
```

`Plugin.trigger` walks the registered plugins in order and calls each hook
function with the **mutable** `result` object. QTK rewrites eligible Bash
commands in `tool.execute.before` (RTK first, then QTK quiet fallback), and
rewrites compressible tool text in `tool.execute.after`.

For normal opencode tools, that text lives at `result.output`. For MCP tools,
the hook sees raw `content` items before opencode flattens them into
`result.output`; QTK normalizes those text content/resource entries and writes
the compressed envelope back to the same result shape.

User-triggered TUI shell commands (`!cmd`) use a separate opencode path and do
not appear to trigger `tool.execute.after` today.

That's the entire integration surface. ~5 lines in opencode we don't have to
touch.

---

## 2. Module layout

```
qtk-plugin/
  src/
    index.ts           ← plugin entry, registers tool.execute.after hook
    types.ts           ← shared type aliases
    registry.ts        ← maps (tool, command) → compressor function
    config.ts          ← loads .opencode/qtk.toml (with sensible defaults)

    cache.ts           ← in-memory session dedup cache
                         fingerprint = sha256(tool + canonical-args)
                         entry = { outputHash, ts, compressedOutput }
                         TTL = 60s default

    tee.ts             ← writes recoverable output under project tee directory
                         (content follows redaction config); mode 0o600

    stats.ts           ← SQLite logger
                         schema = (ts, sessionID, tool, command_head,
                                    result_shape, source, lossy, bytes, ratio, ...)

    estimator.ts       ← token estimator (chars/4, matches opencode's)
    result-text.ts     ← extracts/mutates normal output and MCP text content

    compressors/       ← per-command compressors
      git.ts             git status / log (2 distinct compressors)
      ls.ts              ls / ls -la
      find.ts            find / fd path-list clustering
      rg.ts              ripgrep output (also covers `grep -r`)
      package-manager.ts npm / pnpm / bun / yarn install/list noise
      cargo.ts           cargo build/test/clippy
      pytest.ts          pytest summaries
      generic-text.ts    lossless-by-default fallback; lossy summaries are opt-in

    tools/             ← compressors for built-in opencode tools
      read.ts            Read tool → outline if too long
      grep.ts            Grep tool → group by file
      glob.ts            Glob tool → cluster by directory

    rtk.ts             ← external RTK helper resolution/rewrite
    dsl/               ← project-local TOML filters
    sidecar/           ← optional qtk-core client and async wrappers
    cli/               ← qtk gain analytics
```

---

## 3. Request lifecycle (one tool call)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ opencode agent loop                                                     │
│                                                                         │
│ 1. LLM emits tool_use: bash {"command": "git status"}                   │
│                                                                         │
│ 2. session/tools.ts wraps the bash tool's execute()                     │
│    ↓                                                                    │
│    fires Plugin.trigger("tool.execute.before") → QTK plugin              │
│    QTK invokes external RTK helper first when it resolves; suggestions    │
│    are accepted by default (allow=["*"], deny=[])                         │
│    ↓                                                                    │
│ 3. bash tool runs the command, captures stdout+stderr to result.output  │
│    (1.8 KB of porcelain text)                                           │
│    ↓                                                                    │
│ 4. fires Plugin.trigger("tool.execute.after") → QTK plugin              │
│    ↓                                                                    │
│ 5. QTK hook (this is the QTK logic):                                    │
│                                                                         │
│    a. Extract/normalize result text; handle tee recall pass-through      │
│    b. Compute fingerprint and lookup output-equality session cache      │
│       (cache hit reuses result without recompression)                    │
│                                                                         │
│    c. Pick compressor:                                                  │
│         registry.lookup(tool, args.command)                             │
│         If no match → leave output unchanged today                      │
│                                                                         │
│    d. compressor.compress(result.output) → compressed string            │
│         If compressor throws → log + leave output unchanged             │
│                                                                         │
│    e. Build complete model-facing envelope; require estimated token      │
│       savings >= configured ratio (default 10%) or pass raw through      │
│         result.output = `<qtk-compressed orig_lines=X ratio=Y           │
│                           tee=qtk-tee/<callID>.log>`                    │
│                          ${compressed}                                  │
│                          </qtk-compressed>`                             │
│         tee.write(callID, result.output) unless lossless=true            │
│                                                                         │
│    f. Record every after-hook call in global SQLite calls table;         │
│       retain compression/cache details separately                        │
│    g. Cache accepted result; call record also includes pass-through       │
│                                                                         │
│ 6. OpenCode V1 result conversion → LLM context                          │
│    (250 bytes of compact text + 1.8 KB invisible on disk)               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Compressor interface

Every compressor implements:

```ts
export interface Compressor {
  /** Stable identifier for stats and config overrides. */
  readonly name: string;

  /**
   * Does this compressor want to handle (tool, args)? Pure function, no I/O.
   * Returning true commits to compressing — registry stops searching.
   */
  matches(tool: string, args: Record<string, unknown>): boolean;

  /**
   * Synchronous, deterministic transformation of raw output → compact output.
   * Must NEVER throw. If something goes wrong, return the input unchanged.
   * Must NEVER do I/O. Pure string-in-string-out.
   */
  compress(raw: string, ctx: CompressorContext): string;
}

export interface CompressorContext {
  /** The full tool args, in case compressor wants to inspect flags. */
  readonly args: Record<string, unknown>;
  /** Project root (Instance.directory equivalent). */
  readonly cwd: string;
  /** Optional config snapshot for this compressor. */
  readonly config: Record<string, unknown>;
}
```

**Why synchronous and pure?** Two reasons:

1. **No I/O = no failure modes we can't bound.** A compressor that reads a file
   could block on a stuck NFS mount; a compressor that calls an LLM could time
   out. By keeping compressors as pure string transformers, the worst-case
   latency is bounded by the regex engine.

2. **Determinism makes tests trivial.** Golden-file tests: `compress(fixture)
== expected_output`. No mocks, no async, no flake.

The registry is the **only** place that does I/O — it reads config and dispatches.

---

## 5. Cache & dedup

The session cache is the single most impactful optimisation in Phase 1 — it's
also the simplest:

```ts
class SessionCache {
  private entries = new Map<string, CacheEntry>();

  fingerprint(tool: string, args: Record<string, unknown>): string {
    const canonical = JSON.stringify(args, Object.keys(args).sort());
    return sha256(`${tool}\0${canonical}`);
  }

  lookup(fp: string, outputHash: string, ttlMs: number): CacheEntry | null {
    const e = this.entries.get(fp);
    if (!e) return null;
    if (Date.now() - e.ts > ttlMs) return null;
    if (e.outputHash !== outputHash) return null; // output changed → recompute
    return e;
  }

  put(fp: string, outputHash: string, compressed: string) {
    this.entries.set(fp, { outputHash, compressed, ts: Date.now() });
    // simple LRU: if > 500 entries, drop the oldest 100
    if (this.entries.size > 500) {
      const oldest = [...this.entries.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, 100);
      for (const [k] of oldest) this.entries.delete(k);
    }
  }
}
```

Note the subtle point in `lookup`: we don't just match the fingerprint — we
also need the actual output's hash to match. If `git status` is called now and
returns "modified: foo.ts", then in 30s the agent fixes the file and runs
`git status` again returning "nothing to commit", the second call MUST go
through the compressor (output changed). The cache only short-circuits when
output is **identical** to the recent prior call.

This means we always do the work of running the tool and hashing its output;
we just skip the compression+SQLite write if nothing changed. That's still a
big win — most of the latency budget is the compressor's regex passes, not
the file I/O.

---

## 6. Tee fallback

On compression, we write the raw output to disk so the agent can recover it
if it needs to. Path: `.opencode/qtk-tee/<callID>.log`.

```ts
async function tee(callID: string, raw: string): Promise<string> {
  const dir = ".opencode/qtk-tee";
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/${callID}.log`;
  // Write with 0o600 explicitly — DO NOT rely on umask
  // (RTK audit finding §3.1: RTK uses default 0o644 which is world-readable)
  await Bun.write(path, raw, { mode: 0o600 });
  return path;
}
```

Old tee files are pruned at session start (anything > 7 days). We don't prune
during the session — disk is cheap, surprises mid-session are not.

---

## 7. Stats / telemetry — strictly local

Stats use `${XDG_DATA_HOME:-$HOME/.local/share}/qtk/stats.sqlite` globally by
default. Absolute `QTK_STATS_PATH` overrides `[qtk.stats] path`; relative TOML
paths resolve inside the project. Retention defaults to 90 days; zero keeps
rows forever. `qtk gain` is tokens-first; USD is opt-in and RTK totals have a
separate scope. Recall counts (tee references, bypass reruns, RTK recall
signals) are attribution proxies, not proof of causality.

```sql
CREATE TABLE IF NOT EXISTS compressions (
  ts                       INTEGER NOT NULL,
  session_id               TEXT,
  tool                     TEXT NOT NULL,
  command_head             TEXT,           -- first 3 tokens of command line
  compressor               TEXT NOT NULL,  -- name of compressor that handled it
  original_bytes           INTEGER NOT NULL,
  compressed_bytes         INTEGER NOT NULL,
  original_tokens_est      INTEGER NOT NULL,
  compressed_tokens_est    INTEGER NOT NULL,
  ratio                    REAL NOT NULL,  -- compressed / original
  was_cache_hit            INTEGER NOT NULL,
  tee_file                 TEXT,           -- relative path or NULL
  agent_read_tee           INTEGER NOT NULL DEFAULT 0,
  agent_bypass_rerun       INTEGER NOT NULL DEFAULT 0,
  duration_ms              INTEGER NOT NULL,
  result_shape             TEXT NOT NULL DEFAULT 'output',
  compressor_source        TEXT NOT NULL DEFAULT 'builtin',
  is_lossy                 INTEGER NOT NULL DEFAULT 0,
  is_generic               INTEGER NOT NULL DEFAULT 0,
  project                  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_session ON compressions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool ON compressions(tool);
CREATE INDEX IF NOT EXISTS idx_ts ON compressions(ts);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  tool TEXT NOT NULL,
  command_head TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  bytes_in INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  tokens_in_est INTEGER NOT NULL,
  tokens_out_est INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE INDEX IF NOT EXISTS calls_project_ts ON calls(project, ts);
```

We use `bun:sqlite` — comes with Bun, zero deps.

**No network code in QTK.** Period. Not opt-in, not opt-out, not "anonymous
aggregate" — there is no HTTP client in the dependency tree. If you `grep -r
"fetch\|http" qtk-plugin/src/` you should get zero matches.

---

## 8. Failure modes & fallbacks

The cardinal rule: **QTK MUST NEVER break the agent loop.** Every failure
mode falls back to the raw output.

| Failure                                             | What happens                                  | What the LLM sees                           |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Compressor throws                                   | Log, increment circuit breaker                | Raw output (unchanged)                      |
| Compressor returns garbage (zero-length or > input) | Log, ignore result                            | Raw output                                  |
| Cache lookup throws                                 | Log, skip cache                               | Raw output goes through compressor normally |
| Tee write fails                                     | Log, set tee_file = NULL                      | Compressed output without `tee=` attr       |
| Stats write fails                                   | Log only                                      | No effect on output                         |
| Config file invalid TOML                            | Log, use defaults                             | Raw output (compressors disabled)           |
| QTK plugin itself fails to load                     | opencode reports plugin load error, continues | Raw output (no QTK at all)                  |

### Circuit breaker

If a single compressor throws ≥ 3 times in a session, it's disabled for the
rest of that session. We never crash the agent because of a buggy regex.

```ts
class CircuitBreaker {
  private failures = new Map<string, number>();
  private disabled = new Set<string>();
  recordFailure(compressor: string) {
    const n = (this.failures.get(compressor) ?? 0) + 1;
    this.failures.set(compressor, n);
    if (n >= 3) this.disabled.add(compressor);
  }
  isDisabled(compressor: string): boolean {
    return this.disabled.has(compressor);
  }
}
```

---

## 9. Configuration

Config loading order:

1. `~/.config/qtk/qtk.toml` or `$XDG_CONFIG_HOME/qtk/qtk.toml`
2. `<project>/.opencode/qtk.toml`

Project config is merged over global config. Minimal shape:

```toml
[qtk]
enabled = true                # master kill switch
log_level = "info"            # debug | info | warn | error
dedup_ttl_seconds = 60        # cache TTL

[qtk.compression]
min_input_bytes = 200         # global compression threshold

[qtk.rewrite]
enabled = true                # safe Bash quiet rewrites

[qtk.redaction]
enabled = true                # controls redaction of model-facing output and tee files

[qtk.sidecar]
enabled = true                # optional qtk-core parsers
request_timeout_ms = 1000
startup_timeout_ms = 1500
max_restarts = 3
disabled = []                 # sidecar wrapper names to skip

[qtk.tee]
enabled = true
directory = ".opencode/qtk-tee"   # relative to project root, must stay inside
mode = "failures_and_compressed"  # always | failures_and_compressed | never
prune_days = 7                # delete tee files older than this at session start

[qtk.stats]
enabled = true
path = ".opencode/qtk-stats.sqlite" # optional project-local override
retention_days = 90

[qtk.filters]
bundled = true                # packaged RTK-compatible filters
project = true                # .opencode/qtk/filters/*.toml
disabled = []                 # filter names to skip

[qtk.compressors.git_status]
enabled = true                # set false to disable built-in compressor
max_files_per_section = 15

[qtk.compressors.generic_text]
enabled = true                # lossless JSON compaction by default for MCP/task fallback
json_compact_min_saved_bytes = 256
allow_lossy = false           # opt in to JSON/diagnostic/path/markdown/repeated-line summaries
disabled_shapes = []          # json | diagnostics | path_list | markdown | repeated_lines

# Per-tool overrides
[qtk.tools.read]
enabled = true
outline_threshold_lines = 200

[qtk.tools.grep]
enabled = true

[qtk.tools.glob]
enabled = true
```

By default, `generic-text` compacts only valid JSON objects/arrays, removing
whitespace outside string literals while preserving values, number formatting,
and key order. It compresses only when savings meet the configured minimum;
other output passes through unchanged. These lossless results are marked
`lossless=true` and have no tee. With `allow_lossy = true`, the previous
summaries are enabled, marked `lossy=true`, and require a tee; without one, the
output passes through unchanged.

When calls are available, `qtk gain` reports a tokens-first funnel; USD is
opt-in and RTK totals are separately scoped. Legacy compression-only databases
instead produce `legacy_compressions` JSON and omit the funnel; no calls
denominator or reason groups are inferred. `--db PATH` is read-only.

Recall is measured when a later tool call reads a QTK tee file, or when Bash
reruns a command compressed in the same session within 15 minutes with
`QTK_DISABLED=1`. Tee reads pass through uncompressed, with redaction applied
when `[qtk.redaction] enabled` is true. `qtk gain` reports per-group
`recalls`/`recall%` when available. These are attribution proxies, not proof
of causal recovery.

All keys are optional; QTK ships with sensible defaults that work for the
typical opencode user. `docs/examples/qtk.toml` lists the full currently
honored config surface.

---

## 10. Compatibility with RTK

When RTK is installed, QTK runs `rtk rewrite` first and honors its suggestions
by default (`allow = ["*"]`, `deny = []`). Prefix deny rules keep selected
families with QTK; matching is token-wise and per shell segment. Equal segment
counts allow segment-wise selection, while count mismatches use all-or-nothing
policy. Agent-entered denied `rtk <proxy>` segments normalize to the raw command
before RTK runs; RTK-native subcommands such as `read`, `recall`, `proxy`, and
`gain` are never stripped. RTK's own safety checks decline redirects, pipes
into programs, and `--json` requests.

RTK recall activity is counted for Bash `rtk recall` / `rtk proxy`,
`RTK_DISABLED=1` calls, and tools whose args reference RTK's tee directory
(macOS `~/Library/Application Support/rtk/tee`, Linux `${XDG_DATA_HOME:-~/.local/share}/rtk/tee`).
Stats record this as `calls.outcome='recall'` and `reason='rtk'` for aggregation
into a separately scoped RTK report in `qtk gain`. These signals show
recall-related activity, not proof a particular output caused a later read or
rerun.

Canonical passthrough reasons distinguish deliberate retention from gaps:
`kept_exact` means the default-lossless `generic-text` compressor left the
answer unchanged; `small` includes Read outputs below its byte/line thresholds.
`fail_open` is reserved for compressor parse/decline failures and unchanged or
larger compressor output; `no_compressor`, `not_worth_it`, `no_tee`, `excluded`,
and `error` identify their corresponding pipeline exits.

The following is an illustrative RTK flow, not parity certification or live
integration evidence:

1. `tool.execute.before` fires → RTK rewrites `git status` → `rtk git status`
2. Bash tool runs `rtk git status` — RTK's native git filter compresses
   output server-side, produces ~150-byte compact output
3. `tool.execute.after` fires → QTK's git compressor inspects the output
4. Output already starts with `RTK` or matches "compact format" pattern → QTK
   short-circuits, doesn't double-compress

Implementation in `compressors/git.ts`:

```ts
function compress(raw: string): string {
  // If RTK already compressed this, leave it alone.
  if (raw.length < 200 || /^[ML][AMD]\s/.test(raw.trim())) return raw;
  // ... our own compression logic
}
```

No conflict, no double-work, no double-tee. Just an additive layer.

---

## 11. Performance budget

Target: **median additional latency < 5ms per tool call**.

Approximate budget per call:

- Fingerprint hash (sha256 of ~200 bytes): 50 µs
- Cache lookup (Map.get): 1 µs
- Output hash (sha256 of typical 2 KB): 200 µs
- Compressor regex passes: 500 µs – 3 ms (compressor-dependent)
- SQLite insert (in-memory commit, sync to disk async): 100 µs
- Tee write (async, fire-and-forget): 0 µs (not awaited if compression succeeded)

Total: ~1–4 ms typical. Worst case (large output, expensive compressor): ~10 ms.

We benchmark with `scripts/benchmark.ts` — runs every compressor against the
fixture corpus and reports `p50 / p90 / p99` latencies. Anything over 10 ms
p99 is a bug.

---

## 12. What lives where (vs RTK)

| Concern                | RTK                                  | QTK                                     |
| ---------------------- | ------------------------------------ | --------------------------------------- |
| Process model          | External binary, subprocess per call | In-process TS, no subprocess            |
| Compression strategies | Rust regex + TOML DSL                | TS regex (TOML DSL in Phase 2)          |
| Per-call latency       | 5–15 ms (fork + exec + IPC)          | 1–4 ms (in-process)                     |
| Tool scope             | Bash only                            | All tools (Bash, Read, Grep, Glob, MCP) |
| Prompt injection       | CLAUDE.md teaches the model          | None — invisible to model               |
| State                  | Stateless, per-call                  | Session cache + SQLite stats            |
| Telemetry              | Opt-in, phones home                  | Strictly local SQLite                   |
| Tee perms              | 0o644 (umask)                        | 0o600 explicit                          |
| Heavy parsers          | Always in-binary                     | Optional Rust sidecar (Phase 3)         |

QTK's surface area is dramatically smaller than RTK's because RTK is
trying to be a general-purpose CLI proxy for any agent. QTK targets one
specific plugin surface and doesn't need any of the install-script,
hook-installer, exit-code-protocol machinery.
