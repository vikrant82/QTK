# QTK vs RTK — A Detailed Comparison

> QTK's supported host contract is OpenCode V1 only. This comparison is
> architectural background, not a parity certification or live-session report.

> **Read this first:** [RTK](https://github.com/rtk-ai/rtk) is the mature,
> production-grade project. 65k+ GitHub stars, 200+ releases, supports 14
> AI coding tools across Linux/macOS/Windows, and ships 100+ supported
> command filters. It is the project that proved deterministic token compression
> works at scale. Built by Patrick Szymkowiak, Florian Bruniaux, Adrien
> Eppling, and the RTK community. Licensed Apache-2.0.
>
> **If you're not running OpenCode V1 specifically, you almost certainly want
> RTK, not QTK.** RTK supports Claude Code, Cursor, Gemini CLI, GitHub
> Copilot, Codex, Windsurf, Cline, Roo Code, OpenCode, OpenClaw, Pi, Hermes,
> Kilo Code, Antigravity — basically every serious AI coding agent.
>
> QTK is a much narrower project. It asks one question: *if we built this
> specifically for the opencode plugin surface, what would change?* The
> answer is "the architectural diff is meaningful enough to merit a
> separate codebase that we maintain ourselves" — but **the diff is small
> compared to the conceptual debt to RTK**. The whole thesis comes from
> RTK. Most of the filter ideas come from RTK. The TOML DSL syntax is
> RTK-compatible by deliberate design. This doc enumerates every
> meaningful difference and why we chose each tradeoff.

---

## At a glance

|                                  | RTK                                           | QTK                                        |
| -------------------------------- | --------------------------------------------- | ------------------------------------------ |
| Form factor                      | External Rust binary (~8 MB)                  | TypeScript plugin file                     |
| Lines of code                    | ~50,000 Rust + 100+ supported commands        | Target Phase 1: ~3,000 TS                  |
| Installation                     | `cargo install`, `brew install`, `install.sh` | npm/dist for package users; direct source entry for local contributors |
| Process model                    | External binary | Plugin process; helper subprocess when RTK resolves |
| Tool scope                       | Bash command rewriting                        | OpenCode V1 Bash routing via external RTK helper; after-hook handles native tools/MCP text |
| Compression timing               | Before tool call (rewrites command)           | RTK-first before Bash; QTK after-hook processes outputs |
| Prompt overhead                  | ~hundreds of tokens of CLAUDE.md hint         | Zero                                       |
| Per-call latency                 | External process overhead                     | In-process output path; helper cost when RTK resolves |
| Cross-call dedup                 | None                                          | Session cache                              |
| Compaction integration           | None                                          | None; Phase 5 proposal is historical roadmap context |
| Filter authoring                 | Upstream PR to rtk-ai/rtk                     | Project-local filters plus bundled RTK-compatible filters |
| Telemetry                        | Opt-in HTTP POST to operator's endpoint       | Global local SQLite by default; project-attributed |
| Tee perms                        | 0o644 (umask default — world-readable!)       | 0o600 explicit                             |
| Telemetry kill switch            | Runtime + env var                             | Not applicable (no network code exists)    |
| Coverage of `Read`/`Grep`/`Glob` | Zero                                          | Full                                       |
| Built-in test runners            | jest/vitest/pytest/cargo/go/playwright        | Active: pytest/cargo; planned: jest/vitest/playwright/go |
| Standalone CLI                   | Yes (`rtk`)                                   | Only `qtk gain` (optional analytics)       |
| Cross-agent support              | 14+ agents                                    | OpenCode V1 plugin surface only             |

---

## The three structural differences that actually matter

### 1. Where the work happens

**When used through QTK's helper, RTK can rewrite the command** before it runs:

```
LLM → "git status"
QTK → invokes external `rtk rewrite`; allowed rewrite → "rtk git status"
shell → runs rtk binary
rtk → calls git, parses output, prints compact form
```

**QTK coordinates command routing and output processing**:

```
LLM → "git status"
QTK before-hook → external `rtk rewrite` when RTK resolves (default allow all)
shell → runs original or rewritten command
OpenCode V1 → captures output; QTK after-hook compresses eligible results
LLM ← compact form
```

This single architectural flip cascades into most of the wins. Concretely:

- **No QTK prompt injection.** The model need not be taught to call QTK.
  RTK-first rewrites can appear in OpenCode V1 tool history and agents may
  imitate the rewritten `rtk …` command.

- **Permission and history caveat.** OpenCode V1 checks permissions against
  rewritten commands and retains rewritten input in history, so permission
  rules may need `rtk …` variants and agents may imitate the rewritten form.
  QTK normalizes denied/unallowed proxy commands but leaves RTK-native commands.

- **Read/Grep/Glob support.** RTK's hook is on `tool.execute.before` for the
  bash tool only. opencode's built-in `Read`/`Grep`/`Glob` tools never see
  the bash tool's hook. They're real tools with their own `execute()`
  functions. But they all flow through the same `tool.execute.after` wrapper
  — which is where QTK lives. We pick up all of them for free.

- **Stronger safety surface.** RTK has documented `sh -c <user_input>`
  paths in `rtk summary`, `rtk err`, `rtk test`, `rtk proxy` (audit finding
  §2.1). These are intentional shell wrappers, but they widen RTK's attack
  surface meaningfully — if an attacker can influence the model's command
  output, they can chain into shell execution via these meta-commands. QTK
  does not execute the agent's requested command itself; it invokes the
  external RTK rewrite helper and the Bash tool executes the resulting command.

### 2. Process model

When RTK resolves, QTK invokes its helper subprocess for Bash rewriting;
otherwise its output path is in-process TypeScript, with optional qtk-core
sidecar parsing. The latency figures below are historical measurements, not a
current-host or live-session guarantee.

Historically, this process-model distinction mattered for these reasons:

- **Long sessions add up.** A 4-hour yolo session can easily make 500+ tool
  calls. RTK adds 2.5–7.5 seconds of fork overhead; QTK adds 0.5–2 seconds.
  Both invisible to humans, but the budget difference is real.

- **The cost of being out-of-process compounds.** Subprocess output has to
  be captured by opencode anyway (it's the shell's stdout/stderr); now we
  also have to capture rtk's stdout. Doubles the I/O bookkeeping.

The Rust performance argument cuts the other way once you're already in a
JS runtime. RTK's actual compressors are fast Rust regex, but the cost of
_getting to_ them dominates the cost of running them. QTK pays the in-process
JS regex tax, which is higher than Rust regex on hot paths — but we save the
entire IPC roundtrip, which is several orders of magnitude larger.

(Phase 3 introduces an optional Rust sidecar `qtk-core` for genuinely
expensive parsers like JUnit XML or terraform plan. The default Phase 1
plugin doesn't need it.)

### 3. State

**RTK is stateless per call.** Every invocation is independent.

**QTK has a session cache.** The cardinal pattern in agent loops is:

```
1. git status     → 23 lines of output
2. <work happens>
3. git status     → same 23 lines
4. <more work>
5. git status     → still same 23 lines
```

RTK compresses all three calls identically. QTK detects calls 2 and 3 as
**output-equal to the previous call** and short-circuits with:

```
<qtk-unchanged tool=bash command="git status" since=14:23:47>
(prior output: 23 lines, see qtk inspect last)
</qtk-unchanged>
```

On a real agent session, this catches the "list files → make edit → list
files again" pattern hundreds of times. Each hit saves the full compressed
output's tokens.

An earlier Phase 5 roadmap proposed smart compaction, but QTK does not
currently integrate with OpenCode's pruner or replace its output handling.

---

## Things RTK does that QTK deliberately doesn't

### General-purpose command rewriting

QTK has narrow pre-call routing: external RTK rewrite first, then approved
whitelist-only quiet-flag fallback. It is not a general-purpose shell proxy.

QTK invokes RTK as a helper when installed; do not install RTK's OpenCode
plugin alongside it. The QTK after-hook avoids double-compressing RTK results.

### Standalone CLI

RTK ships a CLI binary that's useful even without an agent — you can run
`rtk git status` in your own terminal and get compact output.

QTK doesn't have an equivalent because QTK only exists to serve opencode.
If you want compact git output in your own terminal, use RTK.

### Cross-agent support (Cursor, Gemini, Windsurf, Cline, etc.)

RTK supports many agents because it's a CLI proxy with hook adapters.

QTK targets exactly one surface: OpenCode V1's plugin API. Fork and V2
compatibility are not claimed. For other agents, use RTK or another adapter.

### `rtk discover` / `rtk gain` / `rtk session` analytics CLI

RTK has a rich CLI for inspecting savings. QTK has one analytics command,
`qtk gain`, which reports a tokens-first global QTK funnel, recall proxy
counts, and optional USD. RTK totals are separately scoped; recall indicators
do not establish causal recovery.

The gmux dashboard widget and drill-down inspector described here are roadmap
ideas from an earlier plan, not a claim about current live integration.

### Cryptographic device hashing / salted IDs for telemetry

RTK has thoughtful telemetry privacy (salted SHA-256 device IDs, GDPR
opt-in, etc). QTK doesn't need any of this because there's no telemetry
endpoint. The complexity simply doesn't exist.

---

## Things QTK does that RTK doesn't

### Tool-level compressors for Read/Grep/Glob

The single biggest practical gap in RTK. When an agent is exploring an
unfamiliar codebase, the typical flow is:

```
Glob "src/**/*.ts"           → 200 file paths
Read packages/opencode/...   → 1200-line file
Grep "useEffect" src/        → 80 matches across 20 files
```

That's easily 30 KB of context per exploration round. RTK can't touch any
of it. QTK compresses all three:

- **Glob** → clusters by common directory prefix:

  ```
  src/ui/components/  (47 .ts files)
  src/lib/parsers/    (23 .ts files)
  src/server/api/     (19 .ts files)
  ... and 5 more directories. Full list: see qtk-tee/abc.log
  ```

- **Read** → if file > 200 lines, returns signature outline + offset:

  ```
  <file-outline path="packages/opencode/src/session/prompt.ts" lines=1200>
  L1   import { z } from "zod"
  L18  export const Prompt = createContext(...)
  L36  export const Stop = createError(...)
  L84  export async function load(sessionID: string) { ... }
  L142 export async function spawn(...) { ... }
  L1036 async execute(args, options) { ... }
  ...
  </file-outline>
  Full file in: qtk-tee/abc.log (or call Read with offset=N)
  ```

- **Grep** → groups by file, shows first match per file by default:
  ```
  src/ui/component/foo.ts (3 matches)
    L17: useEffect(() => { setX(value) })
  src/ui/component/bar.ts (12 matches)
    L42: useEffect(() => loadData(), [])
  ...
  ```

### Session dedup

Already covered in §3 above. RTK has no equivalent.

### Historical compaction proposal (not implemented)

RTK is stateless and has no knowledge of OpenCode's compaction system. QTK's
old roadmap proposal to replace pruned output with summaries is not implemented.

### Zero prompt injection

RTK's adoption strategy requires a CLAUDE.md hint or AGENTS.md mention to
teach the model that `rtk` is the better tool. QTK is invisible.

### Local-only telemetry as default and only mode

RTK has thoughtful opt-in HTTP telemetry. QTK has SQLite-only telemetry.
The complexity of opt-in flows, GDPR consent text, salting algorithms,
endpoint security, and the trust required to use any of it... simply doesn't
exist in QTK because we never call out.

---

## Compatibility matrix

Can RTK and QTK be used together in an OpenCode V1 project?

**Yes.** Install QTK as the sole OpenCode plugin and use RTK as its external
helper; do not install RTK's OpenCode plugin alongside QTK.

| Scenario                                            | RTK behaviour                                      | QTK behaviour                                     | Net result                |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- | ------------------------- |
| Model writes `git status`                           | Rewrites to `rtk git status`                       | Inspects output, sees it's already compact, skips | RTK-compressed (best)     |
| Model writes `pytest`                               | Rewrites to `rtk pytest`                           | Skips (output already short)                      | RTK-compressed            |
| Model writes `cat src/foo.ts`                       | No rewrite (rtk has read but agent didn't call it) | Compressed                                        | QTK-compressed            |
| Model uses `Read` tool                              | Hook doesn't fire for non-bash tools               | Compressed                                        | QTK-compressed            |
| Model uses `Grep` tool                              | Bypass                                             | Compressed                                        | QTK-compressed            |
| Model uses `Glob` tool                              | Bypass                                             | Compressed                                        | QTK-compressed            |
| MCP tool returns big JSON                           | Bypass                                             | Compressed (if configured)                        | QTK-compressed            |
| Model writes some exotic `npm run my-custom-script` | No rule, passthrough                               | No rule, passthrough                              | Original (no compression) |
| Two RTK invocations in a row (caching)              | Each is independent fork                           | Session cache catches identical output            | RTK + QTK dedup           |

Using RTK as QTK's helper gives you: RTK's mature filter corpus + QTK's coverage
of the tools RTK can't touch + QTK's session dedup over both.

---

## When to use which

| You want...                                                              | Use                                     |
| ------------------------------------------------------------------------ | --------------------------------------- |
| Token compression in Claude Code, Cursor, Gemini, etc.                   | RTK                                     |
| Token compression in OpenCode V1, with maximum coverage                  | QTK (RTK helper optional)                |
| One unified install across many agents                                   | RTK                                     |
| Zero prompt overhead                                                     | QTK                                     |
| Best-in-class compression of `git`, `cargo test`, `kubectl`, `terraform` | RTK (much more mature filter corpus)    |
| Coverage of `Read`/`Grep`/`Glob` output                                  | QTK (RTK can't reach these)             |
| Live dashboard integration with gmux/tauri                               | Not established by this comparison      |
| Smart compaction in OpenCode sessions                                    | Not currently implemented               |
| No network code at all in your supply chain                              | QTK                                     |
| To not have to think about it                                            | RTK on everything else, QTK on opencode |

---

## On giving credit

QTK is downstream of RTK in every meaningful sense. The thesis (deterministic
compression beats LLM-summarisation), the filter taxonomy (which commands
matter most), the tee-fallback pattern, the TOML filter DSL — all RTK
inventions. QTK takes that and asks "what if we built it for opencode
specifically?". The answer is a much smaller, more focused tool that does
fewer things better in one specific environment.

If you find QTK useful, star RTK too. Patrick Szymkowiak and the contributors
did the hard work.
