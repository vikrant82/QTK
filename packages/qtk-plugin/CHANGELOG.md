# Changelog

All notable changes to QTK will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Built-in `find` / `fd` compressor that clusters one-path-per-line results by containing directory.
- Built-in `package-manager` compressor for `npm`, `npx`, `pnpm`, `pnpx`, `bun`, `bunx`, and `yarn` output noise.
- Packaged RTK-compatible TOML filters now load by default, with project-local filters taking precedence.
- Result-text normalizer for MCP text content arrays/resources, allowing compressors to rewrite MCP text outputs before opencode flattens them.
- `generic-text` fallback compressor for recognizable MCP/task text shapes: path lists, diagnostics, JSON schema summaries, markdown outlines, and repeated/log-like lines. Generic output is marked `lossy=true` and requires a raw tee file.
- Expanded analytics metadata for successful compressions: result shape, compressor source, generic/lossy flags, `qtk gain` breakdowns by tool/source/result shape, and JSON savings export groups.
- Conservative `tool.execute.before` command rewrites for Bash: `pytest -q`, `cargo --quiet`, `npm`/`pnpm install --silent`, and aggressive Gradle `--quiet --console=plain`, with verbosity flags and `QTK_REWRITE_DISABLED=1` escape hatch.
- `qtk-runtime` opencode skill advising agents how to recover exact output from QTK tee files or exact reruns.

## [0.3.1] — 2026-05-26

First post-public-release version. No behaviour changes; everything in
this version is infrastructure + community + the org migration.

### Added

- `--help`, `--version`, `--list-compressors` flags on `qtk-core` binary so it
  behaves like a normal CLI when invoked directly (the long-lived NDJSON
  protocol still kicks in when invoked with no arguments).
- GitHub Actions CI: typecheck + test + bundle (TS), build + test + clippy
  (Rust), integration job that spawns the real binary, benchmark dry runs.
- GitHub Actions release pipeline: on tag push, cross-builds `qtk-core` for
  `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`,
  `x86_64-apple-darwin`, `aarch64-apple-darwin`, plus the TS plugin bundle,
  and attaches all artifacts to the GitHub release.
- Community files: issue templates (bug + feature), PR template, FUNDING.yml
  redirecting funding interest to upstream RTK, top-level `SECURITY.md`
  with coordinated-disclosure policy.
- npm-publishable scaffolding for the qtk-plugin package (homepage,
  repository, bugs, keywords, files allowlist; `npm pack --dry-run`
  produces a 70 KB tarball).
- Bulk-imported all 59 RTK filters from rtk-ai/rtk (Apache-2.0) into
  `packages/qtk-filters/imported/` with full per-file attribution.
- Cost-aware analytics: `pricing.ts` model table, `savings-export.ts`
  writing `<project>/.opencode/qtk-savings.json` every 10s, `qtk gain
  --model=<id>` CLI with USD-saved columns + extrapolation.
- gmux integration across 3 surfaces (tmux status bar, phone PWA card,
  Tauri desktop UI perf strip + per-pane HW row + footer badge).
- `CHANGELOG.md` (this file).

### Changed

- `cargo fmt` formatting applied across `qtk-core` so CI's
  `cargo fmt --all -- --check` passes.
- **Repository moved** from `github.com/fivelidz/QTK` to
  `github.com/qalarc/QTK` (transferred to the Qalarc GitHub organisation).
  All old URLs continue to work via GitHub's automatic transfer redirect.
- Project renamed from "qalcode-style Token Killer" to **"Qalarc Token
  Killer"** (with "Quantised Token Killer" as the backronym).
- README's "Read this first" block + LICENSE attribution NOTICE now
  fully credit RTK upstream.

## [0.3.0] — 2026-05-26

Initial public release on [github.com/qalarc/QTK](https://github.com/qalarc/QTK).

### Phase 1 — Built-in TypeScript compressors

9 hand-written compressors with sub-100µs median latency:

- `git-status` (porcelain → grouped + capped form)
- `git-log` (multi-line commits → one-line `<hash> <date> <author>: <subject>`)
- `ls` (long-format → sorted/grouped form for large listings)
- `rg` / `grep -r` (multi-file results → grouped by file with top matches)
- `pytest` (passing → summary; failing → FAILED + trace heads)
- `cargo build/test/clippy` (Compiling-noise stripped, errors preserved)
- `tool-read` (>200 line files → signature outline)
- `tool-grep` (multi-file results → grouped)
- `tool-glob` (>30 paths → clustered by 2-deep dir prefix)

Infrastructure:

- Session-dedup cache (SHA-256 fingerprint + output hash)
- Tee fallback to `.opencode/qtk-tee/` (mode 0o600, dir 0o700)
- SQLite stats tracker (`.opencode/qtk-stats.sqlite`)
- Circuit breaker (auto-disables a compressor after 3 failures)
- `qtk gain` CLI for session analytics

### Phase 2 — TOML filter DSL

- Hand-written TOML parser tuned for regex strings (`\\s+` → `\s+`)
- Spec validator with compile-time regex check + cross-field validation
- Runtime pipeline: `pass_through_if → strip → dedupe → match → group_by → template → header/footer → truncate`
- Hot-reload via `fs.watch` with 250ms debounce
- Per-file error isolation (one bad filter doesn't break the others)
- `scripts/import-rtk-filters.ts` — translates a local RTK clone to QTK format
- 39 DSL tests including a realistic kubectl-pods end-to-end case (98.2%
  reduction at p99 1.17ms)

### Phase 3 — Rust sidecar `qtk-core`

Optional native binary (1.98 MB stripped) handling heavy parsers:

- **JUnit XML** (quick-xml streaming)
- **Terraform plan** (regex-scan with `OnceLock`-cached patterns)
- **kubectl `-o yaml`/`-o json`** (serde_json for JSON, line-pruner for YAML)
- **Cargo `--message-format=json`** (NDJSON serde_json)

Wire protocol: NDJSON over stdin/stdout. TS client (`src/sidecar/client.ts`)
manages a long-lived subprocess with per-request promise correlation,
1s request timeout, auto-restart up to 3× then permanently disable.
Locator searches env var → bundled → dev-checkout → PATH.

Benchmark (verified locally, single CachyOS workstation):

| Metric | Target | Actual |
|---|---|---|
| Cold start (spawn → hello → first call) | ≤ 30 ms | **2.4–6.7 ms** |
| Throughput (serial, one client) | ≥ 5,000 ops/s | **7,721–13,732 ops/s** |
| Throughput (concurrent batches) | bonus | **10,512–32,994 ops/s** |
| Compression ratios on heavy parsers | "materially better" | **63.5–97.3% saved** |

### Cost-aware analytics

- `src/pricing.ts` — model pricing table (Claude, GPT, Grok, DeepSeek,
  Gemini, local models) with longest-prefix matching
- `src/savings-export.ts` — atomic 10-second flush to
  `<project>/.opencode/qtk-savings.json` for cross-tool dashboards
- `qtk gain` CLI now emits USD-saved columns + daily/monthly/yearly
  extrapolation
- gmux integration: tmux status bar, phone PWA card, Tauri desktop UI
  perf strip all read the savings sidecar

### Safety

- Zero network code anywhere (Rust crate has no HTTP deps; TS plugin has no HTTP deps)
- `unsafe_code = "deny"` in the Rust crate
- Tee files mode 0o600, dir 0o700, path-confined to project root
- Secrets-aware redaction on tee files (AWS, GitHub PAT, OpenAI, Slack, Bearer)
- Circuit breaker auto-disables flaky compressors
- Length-monotonicity guard: compression can never make output larger
- `catch_unwind` around all parsers in Rust — panic in parser doesn't kill sidecar

### Testing

- 112 TypeScript tests + 22 Rust tests = **134 tests passing, 256 assertions**
- Sidecar integration tests spawn the real binary; auto-skip if not built
- All 4 Rust parsers have malformed-input + length-monotonicity tests

### Acknowledgements

The entire QTK project is downstream of
[**RTK** (Rust Token Killer)](https://github.com/rtk-ai/rtk) by Patrick
Szymkowiak, Florian Bruniaux, Adrien Eppling and contributors
(Apache-2.0). RTK proved the deterministic-compression thesis at scale
and ships the upstream filter corpus QTK's import script translates.
If you're not on opencode specifically, [use RTK](https://rtk-ai.app).

---

[Unreleased]: https://github.com/qalarc/QTK/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/qalarc/QTK/releases/tag/v0.3.1
[0.3.0]: https://github.com/qalarc/QTK/releases/tag/v0.3.0
