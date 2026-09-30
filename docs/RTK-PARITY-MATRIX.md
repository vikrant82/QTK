# QTK ↔ RTK Parity Matrix

This planning matrix tracks QTK's claimed implementation coverage against the command families covered
by [RTK](https://github.com/rtk-ai/rtk). It is a planning artifact, not a claim
that QTK already matches RTK.

This is not parity certification or evidence of live integration. QTK currently
targets OpenCode V1 only; QTK is the sole OpenCode plugin, with RTK used as an
external helper. Native `Read`, `Grep`, `Glob`, and MCP text outputs are already
handled where matching compressors apply.

## Legend

- **Active TS** — registered in `DEFAULT_COMPRESSORS`.
- **Active sidecar** — available when `qtk-core` is detected.
- **Bundled filter** — imported from RTK-compatible TOML and loaded from the
  package by default, unless disabled in `[qtk.filters]`.
- **Planned** — not implemented or not active yet.

## Current QTK coverage

| Family | RTK coverage examples | QTK status | Planned mechanism | Priority |
| --- | --- | --- | --- | --- |
| Native opencode tools | RTK does not auto-compress `Read`/`Grep`/`Glob` via OpenCode rewrite | `Read`, `Grep`, `Glob` active TS; MCP text result mutation supported | Add generic MCP/result-shape compressors | High |
| File listing/search | `ls`, `tree`, `find`, `cat`, `head`, `tail`, `rg`, `grep`, `diff`, `wc` | `ls`, `find`/`fd`, `rg` active TS; `diff` planned | TS or sidecar for large diffs | High |
| Git | `git status`, `log`, `diff`, `show`, `add`, `commit`, `push`, `pull` | `git status`, `git log` active TS | TS/DSL for `diff`, `show`, compact state-changing commands | High |
| GitHub/GitLab CLI | `gh pr/issue/run/repo/api`, `glab` | Planned | TS table/JSON summarizers or bundled filters | Medium |
| JS package managers | `npm`, `pnpm`, `npx`, `bun`, `yarn` | `package-manager` active TS for install/run/list noise | Add safe quiet pre-call rewrites | High |
| JS/TS tests | `jest`, `vitest`, `playwright`, JUnit XML reports | `junit-xml` active sidecar; others planned | TS failure-only compressors; sidecar for XML reports | High |
| Python | `pytest`, `ruff`, `pip`, `poetry`, `uv` | `pytest` active TS; several bundled filters active by default | Targeted TS where high-volume | High |
| Rust | `cargo build/test/check/clippy/fmt`, JSON message format | `cargo` active TS; `cargo-json` active sidecar | Add flag-aware behavior and more subcommands | Medium |
| Go | `go test`, `golangci-lint` | Planned | DSL/TS failure and lint grouping | Medium |
| Build/lint | `tsc`, `eslint`, `biome`, `prettier`, `next build`, `make`, `mvn`, `gradle`, `swift`, `xcodebuild` | Several bundled filters active by default; no active TS for JS/TS build/lint | TS for `tsc`/`eslint` where needed | High |
| Containers | `docker ps/images/logs/compose`, `kubectl`, `oc` | `kubectl -o yaml/json` active sidecar | DSL/TS for Docker; sidecar for heavy K8s structured output | Medium |
| Infrastructure/cloud | `terraform`, `tofu`, `aws`, `gcloud`, `helm`, `ansible`, `pulumi`, `sops` | `terraform-plan` active sidecar; many bundled filters active by default | Sidecar for heavy JSON/YAML | Medium |
| Network/system | `curl`, `wget`, `ping`, `df`, `du`, `ps`, `systemctl`, `rsync` | Some bundled filters active by default; generic fallback active for recognizable text shapes | Add more specific postprocessors as needed | Medium |
| Generic wrappers | `rtk err`, `rtk test`, `rtk summary`, `rtk log`, `rtk json` | `generic-text` losslessly compacts eligible JSON by default; path lists, diagnostics, JSON schema summaries, markdown outlines, and repeated-log summaries are opt-in with `allow_lossy` | Add RTK/OpenToken-inspired refinements and config | High |
| Security/redaction | Secret-aware command shaping in RTK command families | Model-facing and tee redaction follow `[qtk.redaction] enabled` | Add redaction accounting | Critical |
| Analytics/discovery | `rtk gain`, `discover`, session analytics | `qtk gain` reports a tokens-first calls funnel when available, USD opt-in, separately scoped RTK totals, and recall proxies | Add pass-through/missed-savings, rewrites, redactions | Medium |

## Implementation order

1. **Packaged filter activation** — done: imported RTK-compatible filters load
   from the package, with project filters taking precedence.
2. **Everyday TS compressors** — partially done for package managers and
   `find`/`fd`; remaining: JS test runners, `git diff/show`, `gh`,
   `tsc`/`eslint`, Docker.
3. **Generic postprocessors** — `generic-text` compacts eligible JSON losslessly by default; path/list grouping, diagnostics grouping, JSON schema summaries, markdown outlines, and repeated/log-like line dedupe remain available only with `allow_lossy = true`. Remaining refinements: ANSI strip, richer entropy normalization, long-line truncation, and failure/error extraction.
4. **All-tool result normalization** — partially done: normal output strings
    and MCP text content can be mutated safely; generic `task`/MCP fallback is
    available with lossless JSON compaction by default.
5. **Safe pre-call optimizations** — done for whitelist-only Bash rewrites (`pytest -q`, `cargo --quiet`, `npm`/`pnpm install --silent`, Gradle `--quiet --console=plain`) with verbosity opt-outs and `QTK_DISABLED=1` / `QTK_REWRITE_DISABLED=1` escape hatches.
6. **Model-facing secret redaction** — compressed, pass-through, and MCP text outputs are redacted before they reach the model when `[qtk.redaction] enabled` is true; tee writes follow the same setting.
7. **Analytics expansion** — `qtk gain` reports the calls funnel and compression groups when calls exist; legacy compression-only databases get `legacy_compressions` JSON without inferred funnel, call denominators, or reason groups. `--db PATH` reads without migration or writes. Recall counts are proxies. Remaining: pass-through/missed-savings candidates, rewrites, and redactions.

## What not to port

- RTK's cross-agent hook plumbing; that is RTK's core territory.
- OpenToken-style main-thread LTSC/LZW substring compression.
- Experimental chat/system prompt mutations.
- Hard blocking of reads/searches; QTK should prefer advisory hints and safe
  compression.
