#!/usr/bin/env python3
"""
Generate an SVG bar chart of QTK token savings: raw tool-output tokens
vs. what the model actually received after QTK compression.

Reads the JSON emitted by `bun run scripts/qtk-assess.ts --json` on stdin
or from --in, writes an SVG to --out.

No dependencies — hand-emitted SVG so it embeds anywhere (web, GitHub,
LinkedIn screenshot) and stays crisp at any size.

Usage:
  bun run scripts/qtk-assess.ts --json > /tmp/qtk.json
  python3 scripts/make-savings-graph.py --in /tmp/qtk.json --out qtk-savings.svg
"""

import json
import sys
import argparse


def fmt(n: float) -> str:
    if n < 1_000:
        return str(int(n))
    if n < 1_000_000:
        return f"{n / 1_000:.0f}k"
    if n < 1_000_000_000:
        return f"{n / 1_000_000:.2f}M"
    return f"{n / 1_000_000_000:.2f}B"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", default="-")
    ap.add_argument("--out", dest="outfile", required=True)
    args = ap.parse_args()

    raw = sys.stdin.read() if args.infile == "-" else open(args.infile).read()
    d = json.loads(raw)
    t = d["total"]
    tokens_in = t["tokensIn"]
    tokens_out = t["tokensOut"]
    saved = t["tokensSaved"]
    reduction = 100 * saved / tokens_in if tokens_in else 0
    span = d.get("span_days", 0)
    projects = len(d.get("projects", []))
    calls = t["calls"]

    # ── Layout ────────────────────────────────────────────────────────────
    W, H = 920, 560
    PAD_L, PAD_R, PAD_T, PAD_B = 60, 40, 150, 96
    plot_w = W - PAD_L - PAD_R
    plot_h = H - PAD_T - PAD_B

    # Colours (dark theme to match qalarc.com)
    BG = "#0a1020"
    INK = "#e6edf3"
    MUTED = "#8b98a9"
    RAW = "#3a4a63"  # the "before" — muted slate
    SAVED = "#a6e3a1"  # the "saved" portion — green
    SENT = "#5b8def"  # what actually reached the model — blue
    GRID = "#1c2638"

    # Two bars: "Raw tool output" (full height) and "After QTK" (split:
    # blue = sent to model, faint = the saved gap shown as outline)
    max_val = tokens_in
    bar_w = 150
    gap = 120
    x0 = PAD_L + 120
    x1 = x0 + bar_w + gap

    def y_for(v):
        return PAD_T + plot_h - (v / max_val) * plot_h

    def h_for(v):
        return (v / max_val) * plot_h

    svg = []
    svg.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">'
    )
    svg.append(f'<rect width="{W}" height="{H}" fill="{BG}" rx="14"/>')

    # Title
    svg.append(
        f'<text x="{PAD_L}" y="44" fill="{INK}" font-size="26" font-weight="700">QTK — tool-output tokens: before vs after</text>'
    )
    svg.append(
        f'<text x="{PAD_L}" y="74" fill="{MUTED}" font-size="15">{span:.0f} days · {projects} projects · {fmt(calls)} tool calls compressed</text>'
    )

    # Headline reduction badge
    svg.append(
        f'<text x="{W - PAD_R}" y="50" fill="{SAVED}" font-size="40" font-weight="800" text-anchor="end">{reduction:.1f}%</text>'
    )
    svg.append(
        f'<text x="{W - PAD_R}" y="72" fill="{MUTED}" font-size="14" text-anchor="end">reduction on compressed output</text>'
    )

    # Gridlines (horizontal) at 25/50/75/100% of max
    for frac in (0, 0.25, 0.5, 0.75, 1.0):
        gy = PAD_T + plot_h - frac * plot_h
        svg.append(
            f'<line x1="{PAD_L}" y1="{gy:.1f}" x2="{W - PAD_R}" y2="{gy:.1f}" stroke="{GRID}" stroke-width="1"/>'
        )
        svg.append(
            f'<text x="{PAD_L - 10}" y="{gy + 4:.1f}" fill="{MUTED}" font-size="12" text-anchor="end">{fmt(max_val * frac)}</text>'
        )

    # Bar 1: Raw tool output (full)
    svg.append(
        f'<rect x="{x0}" y="{y_for(tokens_in):.1f}" width="{bar_w}" height="{h_for(tokens_in):.1f}" fill="{RAW}" rx="6"/>'
    )
    svg.append(
        f'<text x="{x0 + bar_w / 2}" y="{y_for(tokens_in) - 14:.1f}" fill="{INK}" font-size="20" font-weight="700" text-anchor="middle">{fmt(tokens_in)}</text>'
    )
    svg.append(
        f'<text x="{x0 + bar_w / 2}" y="{H - PAD_B + 26}" fill="{INK}" font-size="15" font-weight="600" text-anchor="middle">Raw tool output</text>'
    )
    svg.append(
        f'<text x="{x0 + bar_w / 2}" y="{H - PAD_B + 46}" fill="{MUTED}" font-size="12" text-anchor="middle">what the model WOULD see</text>'
    )

    # Bar 2: After QTK — stacked. Bottom = sent to model (blue), top = saved (green outline)
    sent_h = h_for(tokens_out)
    saved_h = h_for(saved)
    bar2_bottom = PAD_T + plot_h
    # sent portion (solid blue) at the bottom
    svg.append(
        f'<rect x="{x1}" y="{bar2_bottom - sent_h:.1f}" width="{bar_w}" height="{sent_h:.1f}" fill="{SENT}" rx="6"/>'
    )
    # saved portion (green, sitting on top, where the bar WOULD have been)
    svg.append(
        f'<rect x="{x1}" y="{bar2_bottom - sent_h - saved_h:.1f}" width="{bar_w}" height="{saved_h:.1f}" fill="{SAVED}" opacity="0.42" stroke="{SAVED}" stroke-width="1.5" stroke-dasharray="5 4" rx="6"/>'
    )
    # labels
    svg.append(
        f'<text x="{x1 + bar_w / 2}" y="{bar2_bottom - sent_h / 2 + 5:.1f}" fill="#0a1020" font-size="15" font-weight="700" text-anchor="middle">{fmt(tokens_out)}</text>'
    )
    svg.append(
        f'<text x="{x1 + bar_w / 2}" y="{bar2_bottom - sent_h - saved_h / 2 + 5:.1f}" fill="{SAVED}" font-size="20" font-weight="800" text-anchor="middle">{fmt(saved)} saved</text>'
    )
    svg.append(
        f'<text x="{x1 + bar_w / 2}" y="{H - PAD_B + 26}" fill="{INK}" font-size="15" font-weight="600" text-anchor="middle">After QTK</text>'
    )
    svg.append(
        f'<text x="{x1 + bar_w / 2}" y="{H - PAD_B + 46}" fill="{MUTED}" font-size="12" text-anchor="middle">what the model ACTUALLY sees</text>'
    )

    # Legend (right side)
    lx = x1 + bar_w + 60
    ly = PAD_T + 20
    svg.append(f'<rect x="{lx}" y="{ly}" width="16" height="16" fill="{SENT}" rx="3"/>')
    svg.append(
        f'<text x="{lx + 24}" y="{ly + 13}" fill="{INK}" font-size="14">Sent to model</text>'
    )
    svg.append(
        f'<rect x="{lx}" y="{ly + 30}" width="16" height="16" fill="{SAVED}" opacity="0.42" stroke="{SAVED}" stroke-dasharray="5 4" rx="3"/>'
    )
    svg.append(
        f'<text x="{lx + 24}" y="{ly + 43}" fill="{INK}" font-size="14">Eliminated by QTK</text>'
    )
    svg.append(
        f'<rect x="{lx}" y="{ly + 60}" width="16" height="16" fill="{RAW}" rx="3"/>'
    )
    svg.append(
        f'<text x="{lx + 24}" y="{ly + 73}" fill="{INK}" font-size="14">Raw (uncompressed)</text>'
    )

    # Footnote — the honesty line
    svg.append(
        f'<text x="{PAD_L}" y="{H - 16}" fill="{MUTED}" font-size="12">Measured across the tool outputs QTK compressed — not total session tokens. Source: qtk-stats.sqlite via qtk-assess.ts. github.com/qalarc/QTK</text>'
    )

    svg.append("</svg>")

    with open(args.outfile, "w") as f:
        f.write("\n".join(svg))
    print(
        f"wrote {args.outfile}  ({tokens_in:,} → {tokens_out:,}, {reduction:.1f}% reduction)"
    )


if __name__ == "__main__":
    main()
