# QTK Task Completion

For TypeScript/plugin changes:
- Run focused test for touched area first, e.g. `bun test packages/qtk-plugin/test/plugin-hook.test.ts`.
- Run `bun run typecheck`.
- Run `bun test` before considering broader plugin changes done.
- Run `cd packages/qtk-plugin && bun run build` when public package/bundle behavior changed.

For Rust sidecar changes:
- Run `cd packages/qtk-core && cargo fmt --all -- --check`.
- Run `cd packages/qtk-core && cargo clippy --release --all-targets -- -D warnings`.
- Run `cd packages/qtk-core && cargo test --release`.
- If sidecar integration changed, build sidecar then run TS tests: `cd packages/qtk-core && cargo build --release`; from repo root `bun test`.

For config/opencode plugin behavior:
- Validate JSON config with `python3 -m json.tool <path> >/dev/null` if editing JSON.
- Restart opencode after changing global/project config, plugin package, agents, skills, or MCP config; opencode does not hot-reload config/plugin files.