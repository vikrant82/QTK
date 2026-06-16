# QTK — LinkedIn launch post (copy-paste ready)

> Generated 2026-06-16 from real data (17 days, 18 projects). Edit freely.
>
> **Attach this image to the post:**
> `docs/assets/qtk-savings-graph.png` (in this repo, next to this file) (1840×1120, ready for LinkedIn)
>
> **Posting tips:**
> - First 2 lines are the hook — they're all most people see before "…see more". Keep them.
> - Put the GitHub/qalarc link in the POST body (one link is fine); put the rest in the FIRST COMMENT. LinkedIn suppresses reach on posts with several external links in the body.
> - Post the image as a native image upload, not a link preview — native images get far more reach.

---

## THE POST

Three weeks ago I started compressing my AI coding agent's tool output before it reaches the model's context.

The result so far: **10.75 million tokens of pure noise eliminated** — git status dumps, directory listings, the same 500-line files read over and over. Across 18 of my projects, the tool outputs it touched shrank by ~91%.

I built **QTK — Qalarc Token Killer**: an open-source plugin for opencode-based agents that rewrites tool output to a compact form before the model sees it. Read a 500-line file → the agent gets a clean outline. Re-run `git status` → "unchanged since 14s ago" instead of the whole dump again.

No LLM. No prompt injection. Sub-millisecond latency. The model just sees less noise.

**97% of the savings came from compressing file reads** — the thing most tools can't reach, because they only hook shell commands.

And this is just the first public piece. QTK is one component of **gmux** — mission control for running fleets of AI agents at once: gesture control, voice commands, a phone remote, per-agent status, and live token/cost dashboards (powered by the QTK data above). gmux isn't public yet. QTK is.

Full credit to **RTK (rtk-ai/rtk)** — Patrick Szymkowiak, Florian Bruniaux and Adrien Eppling proved this whole idea works at scale, across 13 AI tools, with a 100+ filter corpus. If you're not on opencode, use RTK — it's the mature, canonical project, and QTK imports its filters wholesale.

Where QTK goes further: RTK is an external CLI, so it only sees shell commands. QTK lives inside the agent as a plugin, which lets it reach what RTK structurally can't —
→ compresses file reads, searches, and built-in tools, not just Bash (that's the 97%)
→ zero per-call overhead: no subprocess fork, nothing injected into the prompt
→ a session dedup cache: re-run a command, get "unchanged" instead of a recompress

Same thesis, one layer deeper. RTK goes wide across every agent; QTK goes deep into one.

Free, MIT, zero network code, fully local.

→ https://qalarc.com/projects/project/?slug=qtk

Technical deep-dive + gmux preview in the comments.

#AI #DeveloperTools #OpenSource #AIAgents

---

## THE FIRST COMMENT (post this immediately after, as a comment on your own post)

How QTK works — the tool.execute.after hook, the TOML filter DSL, the Rust sidecar, full benchmarks:
https://qalarc.com/blog/posts/ai-systems/qtk-technical

Plain-English version:
https://qalarc.com/blog/posts/ai-systems/qtk-layman

The gmux orchestrator QTK plugs into:
https://qalarc.com/blog/posts/ai-systems/gmux-technical

Source (MIT) + npm package @qalarc/qtk-plugin:
https://github.com/qalarc/QTK

More on gmux soon. 👀

---

## SHORTER VARIANT (if you want a tighter post)

My AI coding agent kept re-reading the same files and re-running the same `git status` — burning tokens on output it had already seen.

So I built **QTK — Qalarc Token Killer**: an open-source plugin that compresses tool output before it reaches the model. No LLM, no prompt injection, sub-millisecond latency.

Three weeks of real data: **10.75M tokens eliminated, 91% reduction, across 18 projects.** 97% of it from compressing file reads — the thing tools that only hook shell commands can't reach.

It's the first open piece of gmux, my agent-fleet orchestrator (more on that soon).

Downstream of RTK (rtk-ai/rtk) — they proved this works at scale across 13 AI tools. QTK is the opencode-native version that hooks tools in-process. RTK goes wide; QTK goes deep.

Free, MIT, fully local.

→ https://qalarc.com/projects/project/?slug=qtk

#AI #DeveloperTools #OpenSource #AIAgents

---

## FACT-CHECK (all verified against real data on 2026-06-16)

| Claim | Status |
|---|---|
| "10.75 million tokens eliminated" | ✅ exact: 10,751,507 (now climbing — re-run `bun run scripts/qtk-assess.ts` for latest) |
| "91% reduction on outputs it touched" | ✅ 91.4% (11.76M → 1.01M); NOTE: this is on compressed outputs, NOT total session tokens — keep the qualifier |
| "18 projects" | ✅ |
| "97% from file reads" | ✅ tool-read = 10.21M of 10.75M |
| "sub-millisecond latency" | ✅ p99 under 1ms |
| "no LLM / no prompt injection / zero network code" | ✅ confirmed in code |
| "downstream of RTK, 13 AI tools, 100+ filters" | ✅ correct attribution |
| "RTK goes wide, QTK goes deep" | ✅ honest scoping — QTK is NOT broader/more mature than RTK; it's deeper on one target only |
| "first piece of gmux" | ✅ gmux is private; framed as "coming", linked via blog only |

**The one thing to NOT say:** don't drop the "on the outputs it touched" qualifier from the 91%. Bare "91% reduction" reads as "91% off your whole bill", which is false. The 10.75M absolute number is the unqualified, bulletproof claim — lead with that.

---

## REFRESHING THE NUMBERS LATER

The numbers grow as QTK keeps running. To get current figures + regenerate the graph:

```bash
cd ~/projects/QTK
bun run scripts/qtk-assess.ts                              # current totals
bun run scripts/qtk-assess.ts --json > /tmp/qtk.json
python3 scripts/make-savings-graph.py --in /tmp/qtk.json --out docs/assets/qtk-savings-graph.svg
rsvg-convert -w 1840 docs/assets/qtk-savings-graph.svg -o docs/assets/qtk-savings-graph.png
```
