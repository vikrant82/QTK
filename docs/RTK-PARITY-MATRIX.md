# QTK ↔ RTK Parity Matrix

This matrix tracks QTK's current coverage against the command families covered
by [RTK](https://github.com/rtk-ai/rtk). It is a planning artifact, not a claim
that QTK already matches RTK.

QTK's goal is not to clone RTK's cross-agent integrations. The goal is to bring
RTK-style deterministic compression coverage to opencode's native
`tool.execute.after` surface, including `Read`, `Grep`, `Glob`, and eventually
MCP text results that RTK's OpenCode rewrite plugin does not compress today.

## Legend

- **Active TS** — registered in `DEFAULT_COMPRESSORS`.
- **Active sidecar** — available when `qtk-core` is detected.
- **Bundled filter** — imported from RTK-compatible TOML and loaded from the
  package by default, unless disabled in `[qtk.filters]`.
- **Planned** — not implemented or not active yet.

## Current QTK coverage

| Family | RTK coverage examples | QTK status | Planned mechanism | Priority |
| --- | --- | --- | --- | --- |
| Native opencode tools | RTK does not auto-compress `Read`/`Grep`/`Glob` via OpenCode rewrite | `Read`, `Grep`, `Glob` active TS | Extend result normalizer to MCP text | High |
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
| Network/system | `curl`, `wget`, `ping`, `df`, `du`, `ps`, `systemctl`, `rsync` | Some bundled filters active by default; no generic active fallback | Generic postprocessors | Medium |
| Generic wrappers | `rtk err`, `rtk test`, `rtk summary`, `rtk log`, `rtk json` | Planned | Generic postprocessors after normal registry misses | High |
| Security/redaction | Secret-aware command shaping in RTK command families | Tee redaction only today | Global model-facing redaction pass | Critical |
| Analytics/discovery | `rtk gain`, `discover`, session analytics | `qtk gain` exists for compression stats | Extend stats for source/family/result-shape, rewrites, redactions, misses | Medium |

## Implementation order

1. **Packaged filter activation** — done: imported RTK-compatible filters load
   from the package, with project filters taking precedence.
2. **Everyday TS compressors** — partially done for package managers and
   `find`/`fd`; remaining: JS test runners, `git diff/show`, `gh`,
   `tsc`/`eslint`, Docker.
3. **Generic postprocessors** — ANSI strip, log entropy normalization, repeated
   line dedupe, path/table grouping, long-line truncation, JSON schema summary,
   and failure/error extraction.
4. **All-tool result normalization** — support MCP text content and any other
   opencode result shape that can be mutated safely.
5. **Safe pre-call optimizations** — whitelist-only quiet flag rewrites with
   `QTK_DISABLED=1` escape hatch.
6. **Model-facing secret redaction** — redact compressed and pass-through output
   before it reaches the model.
7. **Analytics expansion** — make `qtk gain` explain savings by compressor
   source, family, result shape, sidecar, generic fallback, rewrites, redactions,
   and missed-savings candidates.

## What not to port

- RTK's cross-agent hook plumbing; that is RTK's core territory.
- OpenToken-style main-thread LTSC/LZW substring compression.
- Experimental chat/system prompt mutations.
- Hard blocking of reads/searches; QTK should prefer advisory hints and safe
  compression.
