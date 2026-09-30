# QTK Conventions

- Keep compressors pure, deterministic string-in/string-out transforms: no I/O, no Date/random, no LLM/network, bounded output, adversarial-safe regexes.
- Compression must be monotonic: never replace output with a larger string. Add explicit guards where needed.
- Built-in opencode tools match by lowercased tool name (`read`, `grep`, `glob`). Bash command compressors match lowercased `bash` and inspect `args.command`. Generic fallback is last-resort only and excludes exact-code/mutation tools. Fidelity contract (human-approved 2026-09-30): never lossy-summarize answers; default generic mode is lossless JSON whitespace compaction (`lossless=true`, no tee), everything else passes through; lossy summaries only with `[qtk.compressors.generic-text] allow_lossy = true` (then `lossy=true`, tee required). Reads of QTK tee paths always pass through uncompressed (recall).
- Registry is first-match wins. User DSL filters loaded from `.opencode/qtk/filters/*.toml` are prepended before built-ins so users can override.
- Tee files are security-sensitive: write under project root only, redact secrets, mode `0o600`; directory mode `0o700`.
- Stats are local-only SQLite. Do not add network telemetry. Current stats/gain track successful compressions by compressor, tool, compressor source, result shape, generic/lossy flags, tee file, bytes/tokens/ratio, duration, and cache hits.
- Style from CONTRIBUTING: strict TS, avoid `any`, prefer Bun APIs, avoid unnecessary `let`/`else`/`try-catch`, no external runtime deps in plugin unless explicitly justified.
- New compressor flow: add `src/compressors/<name>.ts`, implement `Compressor`, register in `src/registry.ts`, add realistic fixtures/tests, and benchmark if adding a new command category.