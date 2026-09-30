# QTK Core

- Bun workspace for deterministic opencode tool-output compression; main package `packages/qtk-plugin`, optional Rust sidecar `packages/qtk-core`, imported filter corpus under `packages/qtk-filters`.
- QTK plugin registers OpenCode V1 before/after hooks: RTK-first bash routing before execution; native-tool/MCP and fallback compression after execution, with no double compression of RTK. For current ownership, fidelity, global telemetry and runtime setup read `mem:architecture/rtk-hybrid`.
- OpenCode V1 hook input supplies `{ tool, sessionID, callID, args }` for built-in and model MCP tools. Do not assume args live only in `output.metadata`.
- MCP tools hit `tool.execute.after` before opencode flattens MCP `content` arrays into normal output. QTK uses `src/result-text.ts` to mutate normal `{ output }` and MCP text/resource entries safely.
- User-triggered shell commands in opencode TUI (`!cmd`) flow through `session/prompt.ts::shellImpl`, not `SessionTools.resolve`; they do not appear to trigger `tool.execute.after` in current opencode.
- Plugin runtime modules: `src/index.ts` orchestration/hooks; `src/rewrite.ts` safe pre-call Bash quiet rewrites; `src/result-text.ts` normal/MCP text mutation; `src/registry.ts` compressor ordering; `src/tools/*` native Read/Grep/Glob compressors; `src/compressors/*` Bash/generic compressors; `src/dsl/*` TOML filters; `src/sidecar/*` qtk-core bridge; `src/stats.ts` SQLite local telemetry; `src/tee.ts` recovery files subject to redaction configuration; `src/cli/gain.ts` savings analytics.
- For current RTK hybrid behavior, read `mem:architecture/rtk-hybrid`; for revival implementation status, verified limits, and delivery checkpoint, read `mem:tasks/rtk-revival`.
- Read `mem:knowledge/tech-stack` for stack, `mem:knowledge/suggested-commands` for common commands, `mem:knowledge/conventions` for implementation invariants, and `mem:knowledge/task-completion` for verification expectations.

## Current focus
- Revival delivery status and remaining verified work are tracked in `mem:tasks/rtk-revival`; current hybrid contracts and runtime limits are in `mem:architecture/rtk-hybrid`.
