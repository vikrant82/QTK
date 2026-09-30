# QTK Tech Stack

- TypeScript ESM, Bun workspace, package manager pinned in root `package.json`: `bun@1.3.6`.
- Strict TypeScript via root `tsconfig.json`: `strict`, `moduleResolution: bundler`, `target/module: ESNext`, `types: [bun]`, includes `scripts/**/*`, `packages/*/src/**/*`, `packages/*/test/**/*`.
- `packages/qtk-plugin`: npm package `@qalarc/qtk-plugin`, Bun build target, peer dependency `@opencode-ai/plugin`; runtime intentionally has no network deps and minimal runtime deps.
- `packages/qtk-core`: Rust 2021 binary `qtk-core`, no unsafe code, deps include `serde`, `serde_json`, `regex`, `quick-xml`; release profile optimized and stripped.
- Tests: Bun test for TS/plugin; Cargo build/test/clippy/fmt for Rust sidecar; CI also runs an integration pass after building sidecar.
- Local telemetry/artifacts: stats default to `${XDG_DATA_HOME:-$HOME/.local/share}/qtk/stats.sqlite`; older project databases may remain at `.opencode/qtk-stats.sqlite`. Project artifacts include `.opencode/qtk-savings.json` and `.opencode/qtk-tee/*.log`. All are runtime data, not source; current telemetry contracts are in `mem:architecture/rtk-hybrid`.
