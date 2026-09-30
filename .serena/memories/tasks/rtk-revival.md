# QTK RTK revival — current implementation and delivery checkpoint

## Implementation state
- Direct-route revival implemented locally: QTK/RTK hybrid routing, default RTK-first rewrites, QTK native-tool/MCP handling, lossless generic JSON compaction by default, guarded grep/rg compression, final-envelope savings guard, global per-call telemetry, and tokens-first `qtk gain` reporting.
- Human-approved RTK routing defaults trust RTK suggestions (`allow=["*"]`, `deny=[]`); do not restore a restrictive noise allowlist without approval. Redaction remains code-default enabled; user-specific masking policy is not specified here.
- An improvement skill was authored and scenario-tested outside this repository; it is not activated and is not part of this memory publication scope.
- For stable hook, fidelity, telemetry, and runtime contracts, see `mem:architecture/rtk-hybrid`.

## Review and verification
- Scoped reviews and follow-ups reproduced and fixed the identified delivery-slice issues; no remaining scoped blockers were reported. Do not imply independent review covered work outside its stated scope.
- Recorded verification: TypeScript typecheck passed and the full Bun test run reported 333 passing tests. A later focused config test run reported 14 passing tests. These are historical results, not evidence of a fresh separated delivery patch.
- No package build or live restarted OpenCode integration was verified. Bundled RTK-derived filters are not proven behaviorally equivalent; generic lossy summaries remain opt-in; RTK output does not receive QTK's final-token guard or QTK tee/stat accounting.

## Delivery checkpoint
- Approved target: branch `feat/rtk-hybrid-revival`, for the `personal` fork, targeting its `main` branch.
- Pending: verify the separated patch contains only approved revival changes and approved publication memories; then commit, push, and open the PR. Do not include unrelated edits, `.serena` project config/cache, or other untracked/private data.
- Delivery is authorized, but no claim that separation, commit, push, or PR creation is complete should be made until each has actually occurred.
