# QTK / RTK hybrid — current local implementation

## Ownership and fidelity
- OpenCode compatibility scoped to V1. QTK is the single installed OpenCode plugin; RTK is an external helper binary, not a second OpenCode plugin.
- Human-approved philosophy: compress noise, preserve actionable answers, unknown formats fail open, measure full-output recovery. Human subsequently rejected an overly conservative RTK noise allowlist: current default trusts RTK's suggested rewrites (`allow=["*"]`, `deny=[]`). Do NOT silently reinstate an rg/grep deny list; proposed, not approved.
- Before bash execution: QTK calls `rtk rewrite <whole-command-as-one-argv>` without shell, timeout 1000ms. Exit 0/3 rewrite; exit 1/errors/timeouts decline -> QTK quiet-rewrite fallback; exit 2 leaves unchanged (OpenCode permissions, not RTK/Claude rules, govern execution). `src/rtk.ts` owns resolution, rewrite result, quote-aware shell segments, per-segment apply, agent-typed RTK normalization.
- Config `[qtk.rtk] enabled,binary,rewrite_timeout_ms,allow,deny`; deny wins token-wise. Per-segment merging preserves declined segments; count mismatch requires rewritten segments to be allowed RTK segments or identical original segments. Single/double quotes, escapes, substitutions/backticks opaque; unbalanced quoting/heredocs decline normalization/merge.
- After hook: RTK commands stand down (no double compression); QTK handles native read/grep/glob, remaining bash, MCP/task. Global/per-call QTK_DISABLED and rewrite-specific opt-outs remain.
- OpenCode V1 checks permissions on rewritten commands and persists rewritten `state.input`; after-hook cannot restore original input. Agents imitate `rtk` from history. Normalization only removes denied/unallowed proxied RTK commands, never RTK-native commands. `!cmd` TUI shell path may bypass hooks.

## QTK output rules
- Generic MCP/task fallback lossless by default: validated JSON object/array, remove only whitespace outside strings using original-text scanner; preserve values, number lexemes, duplicate keys/key order/escapes. `json_compact_min_saved_bytes=256`, `lossless=true`, no tee. Otherwise raw. Legacy summaries require `allow_lossy=true`, lossy=true and recoverable tee.
- rg fail open on OpenCode truncation, zero matches, <80% parseable lines, targeted/context flags. Native grep preserves limit notices. Defaults 5 matches/file, 200 chars/line, native grep min_matches=20.
- Final envelope must save >=`[qtk.compression] min_savings_ratio` (0.10) using estimated tokens (not actual tokenizer); check before tee/cache/stats.
- Tee reads pass through uncompressed. Tee masking follows `[qtk.redaction] enabled`; the production default remains enabled.
- `<qtk-unchanged>` includes complete cached body, not a pointer; 60s TTL, plugin-wide cache. Manual pruning is safe for repeated output. Skill was corrected to this behavior.

## Telemetry and CLI
- `src/stats.ts`: global `${XDG_DATA_HOME:-$HOME/.local/share}/qtk/stats.sqlite`; QTK_STATS_PATH > config path (legacy database alias) > default. Absolute config accepted; relative confined to project. WAL, 250ms busy timeout, drop busy writes; directory 0700/default dir hardened, DB/WAL/SHM 0600; retention_days=90 (0 forever).
- `compressions` retains compression/cache rows and adds project; `calls` stores one after-hook event with epoch-ms ts, session_id, project, tool, command_head, outcome/reason, input/output bytes and estimated tokens.
- Outcomes compressed/cache_hit/passthrough/rtk/bypass/recall; reasons small/no_compressor/fail_open/not_worth_it/no_tee/excluded/kept_exact/error. Answer/UI tools and generic exclusions are kept_exact; excluded text still counted.
- QTK recalls: flag originating tee row or latest same-session command-head bypass within 15min. RTK recalls: recall/proxy, RTK_DISABLED=1, RTK tee refs -> outcome recall reason rtk. Signals are proxies, not exact causal attribution.
- gain: tokens-first all-project funnel, compressor table, recalls, genuine uncompressed candidates, RTK totals separately labelled all-time/scope. USD opt-in; no extrapolation. Flags --db --days --all --session --project --by --json --usd --model --no-rtk. Legacy DBs readable with --db, no automatic migration/import from old project files. runGain test seam.

## Runtime local setup / gotchas
- Work profile can load the plugin source entry `packages/qtk-plugin/src/index.ts` directly; restart OpenCode to load changes. A package-directory entry may load a stale built artifact instead.
- The installed RTK binary may differ from available source; verify installed behavior rather than inferring it solely from source.
- RTK 0.50 declines programmatic pipes/redirects and structured flags in tested shapes. rg abbreviates paths regardless of display width; recovery hints available. npm test TAP not usefully compressed by either engine: not an allowlist issue.
- RTK raw recovery store is unmasked local disk. QTK does not currently impose its final-token guard or tee/stat compression accounting on RTK output; RTK has its own counters.

For the revival delivery checkpoint and verified limits, see `mem:tasks/rtk-revival`.
