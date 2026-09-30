# QTK Suggested Commands

From repo root:

- Install deps: `bun install --frozen-lockfile` (CI) or `bun install` for local dev.
- Typecheck: `bun run typecheck` (root script -> `bun x tsc --noEmit`).
- Run all TS tests: `bun test`.
- Focused TS test: `bun test packages/qtk-plugin/test/<file>.test.ts`.
- Build plugin bundle: `bun run build` or `cd packages/qtk-plugin && bun run build`.
- Benchmark TS compressors: `bun run scripts/benchmark.ts` or root `bun run bench`.
- Benchmark sidecar: `bun run scripts/benchmark-sidecar.ts` or root `bun run bench:sidecar`.
- Rust sidecar checks: `cd packages/qtk-core && cargo fmt --all -- --check && cargo clippy --release --all-targets -- -D warnings && cargo test --release`.
- Build sidecar binary: `cd packages/qtk-core && cargo build --release`.
- Inspect local QTK savings: `bun run packages/qtk-plugin/src/cli/gain.ts` (or `qtk gain` if installed in PATH).
- Install plugin into opencode config: `bun run install-into-opencode`.
- Import RTK filters: `bun run import-rtk-filters`.