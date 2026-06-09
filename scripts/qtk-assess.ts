// scripts/qtk-assess.ts
//
// Cross-project token-savings assessment. Walks every
// `<project>/.opencode/qtk-stats.sqlite` under a root directory (default
// ~/projects) and rolls up the totals into one report: total tokens
// saved, estimated USD saved, per-project breakdown, per-compressor
// breakdown, and time-window slicing.
//
// This is the "after a few weeks, how much did QTK save me?" tool.
//
// USAGE:
//   bun run scripts/qtk-assess.ts                      # all time, ~/projects
//   bun run scripts/qtk-assess.ts --days=14            # last 14 days only
//   bun run scripts/qtk-assess.ts --root=/some/dir     # different scan root
//   bun run scripts/qtk-assess.ts --model=claude-opus-4-5   # price at Opus rates
//   bun run scripts/qtk-assess.ts --json               # machine-readable output
//
// The per-DB stats are authoritative (they're the raw compression log).
// The qtk-savings.json files are just live snapshots; this tool ignores
// them and reads the SQLite DBs directly so the numbers are exact.

import { Database } from "bun:sqlite";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { lookupPricing, estimateUsdSaved, formatUsd } from "../packages/qtk-plugin/src/pricing.ts";

interface Args {
  root: string;
  days: number | null;
  model: string;
  json: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (p: string) => a.find((x) => x.startsWith(p))?.slice(p.length);
  return {
    root: resolve(get("--root=") ?? join(homedir(), "projects")),
    days: get("--days=") ? Number.parseInt(get("--days=")!, 10) : null,
    model: get("--model=") ?? "claude-sonnet-4-5",
    json: a.includes("--json"),
  };
}

// Recursively find qtk-stats.sqlite files, skipping heavy/irrelevant dirs.
function findStatsDbs(root: string): string[] {
  const out: string[] = [];
  const SKIP = new Set([
    "node_modules",
    ".git",
    "target",
    "dist",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".trash",
  ]);
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return; // safety bound
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    // Direct hit: this dir has a .opencode/qtk-stats.sqlite
    const db = join(dir, ".opencode", "qtk-stats.sqlite");
    if (existsSync(db)) out.push(db);
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      if (e.startsWith(".") && e !== ".opencode") continue;
      const full = join(dir, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory() && e !== ".opencode") walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return [...new Set(out)];
}

interface ProjectTotals {
  project: string;
  calls: number;
  cacheHits: number;
  bytesIn: number;
  bytesOut: number;
  tokensIn: number;
  tokensOut: number;
  tokensSaved: number;
  byCompressor: Map<string, number>; // name -> tokens saved
  firstTs: number;
  lastTs: number;
}

function readDb(dbPath: string, cutoffMs: number | null): ProjectTotals | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const where = cutoffMs ? `WHERE ts >= ${cutoffMs}` : "";
    const agg = db
      .query(
        `SELECT
           COUNT(*) AS calls,
           COALESCE(SUM(was_cache_hit),0) AS cacheHits,
           COALESCE(SUM(original_bytes),0) AS bytesIn,
           COALESCE(SUM(compressed_bytes),0) AS bytesOut,
           COALESCE(SUM(original_tokens_est),0) AS tokensIn,
           COALESCE(SUM(compressed_tokens_est),0) AS tokensOut,
           COALESCE(MIN(ts),0) AS firstTs,
           COALESCE(MAX(ts),0) AS lastTs
         FROM compressions ${where}`,
      )
      .get() as any;
    if (!agg || agg.calls === 0) return null;

    const byComp = new Map<string, number>();
    const rows = db
      .query(
        `SELECT compressor, SUM(original_tokens_est - compressed_tokens_est) AS saved
         FROM compressions ${where} GROUP BY compressor`,
      )
      .all() as any[];
    for (const r of rows) byComp.set(r.compressor, Math.max(0, r.saved ?? 0));

    // project dir is two levels up from .../.opencode/qtk-stats.sqlite
    const project = resolve(dbPath, "..", "..");
    return {
      project,
      calls: agg.calls,
      cacheHits: agg.cacheHits,
      bytesIn: agg.bytesIn,
      bytesOut: agg.bytesOut,
      tokensIn: agg.tokensIn,
      tokensOut: agg.tokensOut,
      tokensSaved: Math.max(0, agg.tokensIn - agg.tokensOut),
      byCompressor: byComp,
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
    };
  } finally {
    db.close();
  }
}

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(2)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function dateStr(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

function main() {
  const args = parseArgs();
  const cutoff = args.days ? Date.now() - args.days * 86400_000 : null;
  const pricing = lookupPricing(args.model);

  const dbs = findStatsDbs(args.root);
  const projects: ProjectTotals[] = [];
  for (const db of dbs) {
    const t = readDb(db, cutoff);
    if (t) projects.push(t);
  }
  projects.sort((a, b) => b.tokensSaved - a.tokensSaved);

  // Roll-up
  const total = {
    calls: 0,
    cacheHits: 0,
    bytesIn: 0,
    bytesOut: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensSaved: 0,
  };
  const compTotals = new Map<string, number>();
  let firstTs = Infinity;
  let lastTs = 0;
  for (const p of projects) {
    total.calls += p.calls;
    total.cacheHits += p.cacheHits;
    total.bytesIn += p.bytesIn;
    total.bytesOut += p.bytesOut;
    total.tokensIn += p.tokensIn;
    total.tokensOut += p.tokensOut;
    total.tokensSaved += p.tokensSaved;
    for (const [k, v] of p.byCompressor)
      compTotals.set(k, (compTotals.get(k) ?? 0) + v);
    if (p.firstTs) firstTs = Math.min(firstTs, p.firstTs);
    lastTs = Math.max(lastTs, p.lastTs);
  }
  const usdSaved = estimateUsdSaved(total.tokensSaved, pricing);
  const spanDays =
    firstTs !== Infinity && lastTs > firstTs
      ? (lastTs - firstTs) / 86400_000
      : 0;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          window: args.days ? `last ${args.days} days` : "all time",
          model: args.model,
          total,
          usd_saved: Number(usdSaved.toFixed(4)),
          span_days: Number(spanDays.toFixed(1)),
          projects: projects.map((p) => ({
            project: relative(args.root, p.project) || p.project,
            calls: p.calls,
            tokens_saved: p.tokensSaved,
            usd_saved: Number(estimateUsdSaved(p.tokensSaved, pricing).toFixed(4)),
          })),
          by_compressor: Object.fromEntries(compTotals),
        },
        null,
        2,
      ),
    );
    return;
  }

  const line = "─".repeat(70);
  console.log(line);
  console.log("QTK savings — cross-project assessment");
  console.log(line);
  console.log(`Scan root:        ${args.root}`);
  console.log(`Window:           ${args.days ? `last ${args.days} days` : "all time"}`);
  console.log(`Pricing model:    ${args.model} (input $${pricing.inputUsdPer1M}/1M)`);
  console.log(`Projects w/ data: ${projects.length}`);
  if (spanDays > 0)
    console.log(`Data span:        ${dateStr(firstTs)} → ${dateStr(lastTs)} (${spanDays.toFixed(1)} days)`);
  console.log("");
  console.log(`Tool calls compressed: ${fmt(total.calls)} (${fmt(total.cacheHits)} cache hits)`);
  console.log(`Bytes:   ${fmt(total.bytesIn)} → ${fmt(total.bytesOut)} (${pct(total.bytesIn ? 1 - total.bytesOut / total.bytesIn : 0)} saved)`);
  console.log(`Tokens:  ${fmt(total.tokensIn)} → ${fmt(total.tokensOut)} (${fmt(total.tokensSaved)} saved)`);
  console.log("");
  console.log(`  ★ TOTAL TOKENS SAVED:  ${fmt(total.tokensSaved)}  (${total.tokensSaved.toLocaleString()})`);
  console.log(`  ★ ESTIMATED USD SAVED: ${formatUsd(usdSaved)}  at ${args.model} list pricing`);
  if (spanDays >= 1) {
    const perDay = total.tokensSaved / spanDays;
    const usdDay = usdSaved / spanDays;
    console.log(`  ★ RUN RATE:            ~${fmt(Math.round(perDay))} tokens/day · ${formatUsd(usdDay)}/day`);
    console.log(`                         → ${formatUsd(usdDay * 30)}/month · ${formatUsd(usdDay * 365)}/year`);
  }
  console.log("");

  console.log("Per project (top 15 by tokens saved):");
  console.log("  project".padEnd(46) + "calls".padStart(8) + "tok-saved".padStart(11) + "USD".padStart(9));
  for (const p of projects.slice(0, 15)) {
    const name = relative(args.root, p.project) || p.project;
    const short = name.length > 44 ? "…" + name.slice(-43) : name;
    console.log(
      "  " + short.padEnd(44) +
        fmt(p.calls).padStart(8) +
        fmt(p.tokensSaved).padStart(11) +
        formatUsd(estimateUsdSaved(p.tokensSaved, pricing)).padStart(9),
    );
  }
  if (projects.length > 15) console.log(`  … and ${projects.length - 15} more projects`);
  console.log("");

  console.log("By compressor (across all projects):");
  const sortedComp = [...compTotals.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, saved] of sortedComp) {
    console.log(
      "  " + name.padEnd(28) + fmt(saved).padStart(11) + " tokens  " + formatUsd(estimateUsdSaved(saved, pricing)).padStart(9),
    );
  }
  console.log("");
  console.log("Note: USD uses list pricing for the chosen model and the INPUT");
  console.log("token rate (tool output is model input). Enterprise/cached tiers");
  console.log("would be lower. Use --model=<id> to reprice. --json for raw data.");
  console.log(line);
}

main();
