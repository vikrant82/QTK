import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGain } from "../src/cli/gain.ts";

const roots: string[] = [];
const NOW = 1_800_000_000_000;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDb(legacy = false): string {
  const root = mkdtempSync(join(tmpdir(), "qtk-gain-test-"));
  roots.push(root);
  const path = join(root, "stats.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE compressions (
      ts INTEGER NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, command_head TEXT NOT NULL,
      compressor TEXT NOT NULL, original_bytes INTEGER NOT NULL DEFAULT 0, compressed_bytes INTEGER NOT NULL DEFAULT 0,
      original_tokens_est INTEGER NOT NULL DEFAULT 0, compressed_tokens_est INTEGER NOT NULL DEFAULT 0,
      ratio REAL NOT NULL DEFAULT 0, was_cache_hit INTEGER NOT NULL DEFAULT 0, tee_file TEXT,
      agent_read_tee INTEGER NOT NULL DEFAULT 0, agent_bypass_rerun INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, result_shape TEXT, compressor_source TEXT,
      is_lossy INTEGER NOT NULL DEFAULT 0, is_generic INTEGER NOT NULL DEFAULT 0${legacy ? "" : ", project TEXT NOT NULL DEFAULT ''"}
    );
  `);
  if (!legacy) db.exec(`CREATE TABLE calls (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL, project TEXT NOT NULL,
    tool TEXT NOT NULL, command_head TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT,
    bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0,
    tokens_in_est INTEGER NOT NULL DEFAULT 0, tokens_out_est INTEGER NOT NULL DEFAULT 0
  );`);
  db.close();
  return path;
}

function addCall(path: string, values: {
  ts?: number; session?: string; project?: string; tool?: string; command?: string; outcome: string;
  reason?: string | null; input?: number; output?: number;
}): void {
  const db = new Database(path);
  db.query(`INSERT INTO calls (ts, session_id, project, tool, command_head, outcome, reason, tokens_in_est, tokens_out_est)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(values.ts ?? NOW - 1_000, values.session ?? "s1", values.project ?? "/work/app",
    values.tool ?? "read", values.command ?? "", values.outcome, values.reason ?? null, values.input ?? 0, values.output ?? 0);
  db.close();
}

function addCompression(path: string, values: { ts?: number; session?: string; project?: string; tool?: string; input?: number; output?: number; read?: number; bypass?: number; cache?: number } = {}): void {
  const db = new Database(path);
  const projectColumn = db.query("PRAGMA table_info(compressions)").all().some((column) => (column as { name: string }).name === "project");
  const fields = "ts,session_id,tool,command_head,compressor,original_tokens_est,compressed_tokens_est,ratio,was_cache_hit,agent_read_tee,agent_bypass_rerun" + (projectColumn ? ",project" : "");
  const slots = projectColumn ? "?,?,?,?,?,?,?,?,?,?,?,?" : "?,?,?,?,?,?,?,?,?,?,?";
  const data: (string | number)[] = [values.ts ?? NOW - 1_000, values.session ?? "s1", values.tool ?? "read", "read", "grep", values.input ?? 100, values.output ?? 40, 0.4, values.cache ?? 0, values.read ?? 0, values.bypass ?? 0];
  if (projectColumn) data.push(values.project ?? "/work/app");
  db.query(`INSERT INTO compressions (${fields}) VALUES (${slots})`).run(...data);
  db.close();
}

const noRtk = { now: NOW, spawnRtk: () => null };

describe("qtk gain report", () => {
  test("reports funnel counts, token totals, reasons and a readable text layout", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "grep", input: 1000, output: 250 });
    addCall(path, { outcome: "cache_hit", reason: "grep", input: 200, output: 50 });
    addCall(path, { outcome: "rtk", input: 100 });
    addCall(path, { outcome: "passthrough", reason: "small", input: 80 });
    addCall(path, { outcome: "passthrough", reason: "no_compressor", input: 60 });
    addCall(path, { outcome: "passthrough", reason: "fail_open", input: 40 });
    addCall(path, { outcome: "passthrough", reason: "not_worth_it", input: 20 });
    addCompression(path, { tool: "search", read: 1 });
    const report = runGain(["--db", path, "--all", "--no-rtk"], noRtk);
    expect(report).toContain("QTK · all time · all projects (1) · 1 session");
    expect(report).toContain("Tool output seen    7 calls · 1.5k tok");
    expect(report).toContain("compressed          2 calls · 1.2k → 300 tok   saved 900 (60.0% of all tool output)");
    expect(report).toContain("handled by RTK      1 call");
    expect(report).toContain("passed through      4 calls · 200 tok");
    expect(report).toContain("fail-open 1 · no compressor 1 · not worth it 1 · small 1");
    expect(report).toContain("Recalls             QTK 1 of 1 compressions (tee reads 1 · bypass reruns 0)");
    expect(report).toContain("grep");
  });

  test("project filtering chooses the longest stored ancestor", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "root", project: "/work", input: 100, output: 50 });
    addCall(path, { outcome: "compressed", reason: "child", project: "/work/app", input: 300, output: 100 });
    addCall(path, { outcome: "compressed", reason: "other", project: "/other", input: 1000, output: 1 });
    expect(runGain(["--db", path, "--all", "--project", "/work/app/src", "--no-rtk"], noRtk))
      .toContain("QTK · all time · app (1) · 1 session\nTool output seen    1 call · 300 tok");
  });

  test("session flag selects only matching calls", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "grep", session: "wanted", input: 200, output: 50 });
    addCall(path, { outcome: "passthrough", reason: "error", session: "other", input: 900 });
    expect(runGain(["--db", path, "--all", "--session", "wanted", "--no-rtk"], noRtk))
      .toContain("Tool output seen    1 call · 200 tok");
  });

  test("days window uses injected current time", () => {
    const path = makeDb();
    addCall(path, { ts: NOW - 8 * 86_400_000, outcome: "passthrough", reason: "small", input: 500 });
    addCall(path, { ts: NOW - 6 * 86_400_000, outcome: "passthrough", reason: "small", input: 25 });
    expect(runGain(["--db", path, "--days", "7", "--no-rtk"], noRtk)).toContain("Tool output seen    1 call · 25 tok");
  });

  test("--by tool groups compressed output by tool", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "grep", tool: "search", input: 400, output: 100 });
    addCall(path, { outcome: "compressed", reason: "read", tool: "file", input: 100, output: 25 });
    addCompression(path, { read: 1 });
    addCompression(path, { tool: "file" });
    const report = runGain(["--db", path, "--all", "--by", "tool", "--no-rtk"], noRtk);
    expect(report).toContain("By tool");
    expect(report).toContain("search");
    expect(report).toContain("file");
    expect(report).toContain("search     1      400 → 100       300   0.0%");
    expect(report).toContain("file       1      100 → 25         75   0.0%");
  });

  test("--by reason groups all outcomes with calls and token columns", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "tool-grep", input: 100, output: 30 });
    addCall(path, { outcome: "passthrough", reason: "no_compressor", input: 40 });
    addCall(path, { outcome: "rtk", input: 20, output: 10 });
    addCall(path, { outcome: "recall", reason: "rtk", input: 5 });
    addCall(path, { outcome: "bypass", reason: null, input: 1 });
    const report = runGain(["--db", path, "--all", "--by", "reason", "--no-rtk"], noRtk);
    expect(report).toContain("By reason                      calls   tok in   tok out");
    expect(report).toContain("  compressed:tool-grep          1      100       30");
    expect(report).toContain("  passthrough:no_compressor     1       40        0");
    expect(report).toContain("  rtk                           1       20       10");
    expect(report).toContain("  recall:rtk                    1        5        0");
    expect(report).toContain("  bypass                        1        1        0");
  });

  test("reason groups sort by calls then input tokens and align capped labels", () => {
    const path = makeDb();
    for (let i = 0; i < 86; i++) addCall(path, { outcome: "passthrough", reason: "fail_open", input: 10 });
    for (let i = 0; i < 127; i++) addCall(path, { outcome: "passthrough", reason: "no_compressor", input: 5 });
    const report = runGain(["--db", path, "--all", "--by", "reason", "--no-rtk"], noRtk);
    const failIndex = report.indexOf("passthrough:fail_open");
    const noCompressorIndex = report.indexOf("passthrough:no_compressor");
    expect(failIndex).toBeGreaterThan(-1);
    expect(noCompressorIndex).toBeGreaterThan(-1);
    expect(noCompressorIndex).toBeLessThan(failIndex);
    expect(report).toContain("By reason                      calls   tok in   tok out");
    expect(report).toContain("passthrough:no_compressor   127      635        0");
    expect(report).toContain("passthrough:fail_open        86      860        0");
  });

  test("reason group ties use input-token totals and truncate labels at forty columns", () => {
    const path = makeDb();
    addCall(path, { outcome: "passthrough", reason: "fail_open", input: 2 });
    addCall(path, { outcome: "passthrough", reason: "no_compressor", input: 9 });
    addCall(path, { outcome: "bypass", reason: "r".repeat(45), input: 1 });
    const report = runGain(["--db", path, "--all", "--by", "reason", "--no-rtk"], noRtk);
    expect(report.indexOf("passthrough:no_compressor")).toBeLessThan(report.indexOf("passthrough:fail_open"));
    expect(report).toContain("  bypass:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr…     1        1        0");
  });

  test("keeps recall percentages within compression-only group denominators", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "grep", tool: "bash", input: 100, output: 20 });
    addCall(path, { outcome: "passthrough", reason: "small", tool: "bash", input: 10 });
    addCall(path, { outcome: "recall", reason: null, tool: "bash", input: 5 });
    addCompression(path, { tool: "bash", read: 1 });
    const report = runGain(["--db", path, "--all", "--by", "tool", "--no-rtk"], noRtk);
    expect(report).toContain("bash     1      100 → 20         80   100.0%");
    expect(report).not.toContain("150.0%");
  });

  test("opportunity grouping strips assignments and cd, but retains a flag as token two", () => {
    const path = makeDb();
    addCall(path, { outcome: "passthrough", reason: "no_compressor", tool: "bash", command: "MODE=ci LANG=C cd /tmp && npm test --run", input: 200 });
    addCall(path, { outcome: "passthrough", reason: "no_compressor", tool: "bash", command: "npm test --watch", input: 100 });
    addCall(path, { outcome: "passthrough", reason: "fail_open", tool: "bash", command: "git -C repo status", input: 50 });
    addCall(path, { outcome: "passthrough", reason: "small", tool: "bash", command: "npm test", input: 500 });
    addCall(path, { outcome: "passthrough", reason: "fail_open", tool: "x".repeat(40), command: "ignored", input: 900 });
    const report = runGain(["--db", path, "--all", "--no-rtk"], noRtk);
    expect(report).toContain("bash npm test");
    expect(report).toContain("2 calls");
    expect(report).toContain("300 tok  no compressor");
    expect(report).toContain("bash git");
    expect(report).toContain("1 call      50 tok  fail-open");
    expect(report).toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxx…");
    expect(report).not.toContain("bash npm test                  3 calls");
  });

  test("reports tee/bypass and recall outcome counts", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "grep", input: 100, output: 30 });
    addCall(path, { outcome: "recall", reason: "tee", input: 0, output: 0 });
    addCompression(path, { read: 1, bypass: 1 });
    expect(runGain(["--db", path, "--all", "--no-rtk"], noRtk)).toContain("QTK 1 of 1 compressions (tee reads 1 · bypass reruns 1)");
  });

  test("splits QTK and RTK recalls and counts recalls as a funnel category", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "grep", input: 100, output: 30 });
    addCall(path, { outcome: "rtk", input: 20 });
    addCall(path, { outcome: "rtk", input: 30 });
    addCall(path, { outcome: "recall", reason: null, input: 5 });
    addCall(path, { outcome: "recall", reason: "rtk", input: 10 });
    addCall(path, { outcome: "recall", reason: "rtk", input: 15 });
    addCompression(path);
    const report = runGain(["--db", path, "--all", "--no-rtk"], noRtk);
    expect(report).toContain("QTK · all time · all projects (1) · 1 session");
    expect(report).toContain("Tool output seen    6 calls · 180 tok");
    expect(report).toContain("QTK 1 of 1 compressions (tee reads 0 · bypass reruns 0) · RTK 2 of 2 RTK calls");
    expect(report).toContain("recovery calls      3 calls · 30 tok");

    const data = JSON.parse(runGain(["--db", path, "--all", "--json", "--no-rtk"], noRtk)) as {
      funnel: { calls: number; categories_total: number; tokens_in_est: number; compressed: { calls: number; tokens_in_est: number; tokens_out_est: number; tokens_saved: number; percent_all_tool_output: number }; rtk: { calls: number; tokens_out_est: number }; recovery: { calls: number; tokens_in_est: number; tokens_out_est: number }; passthrough: { calls: number; tokens_in_est: number } };
      recalls: { qtk: { count: number; denominator: number; tee_reads: number; bypass_reruns: number }; rtk: { count: number; denominator: number } };
    };
    expect(data.funnel).toEqual({ calls: 6, categories_total: 6, tokens_in_est: 180, compressed: { calls: 1, tokens_in_est: 100, tokens_out_est: 30, tokens_saved: 70, percent_all_tool_output: 70 / 180 }, rtk: { calls: 2, tokens_out_est: 0 }, recovery: { calls: 3, tokens_in_est: 30, tokens_out_est: 0 }, passthrough: { calls: 0, tokens_in_est: 0 } });
    expect(data.recalls).toEqual({ qtk: { count: 1, denominator: 1, tee_reads: 0, bypass_reruns: 0 }, rtk: { count: 2, denominator: 2 } });
    expect(data.funnel.compressed.calls + data.funnel.rtk.calls + data.funnel.passthrough.calls + data.funnel.recovery.calls).toBe(data.funnel.calls);
  });

  test("JSON output carries structured scope, funnel, groups and opportunities", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "grep", input: 1000, output: 250 });
    addCall(path, { outcome: "passthrough", reason: "no_compressor", tool: "bash", command: "npm test", input: 80 });
    const data = JSON.parse(runGain(["--db", path, "--all", "--json", "--no-rtk"], noRtk)) as {
      scope: { sessions: number };
      funnel: { compressed: { calls: number; tokens_in_est: number; tokens_out_est: number; tokens_saved: number; percent_all_tool_output: number } };
      passthrough_reasons: Record<string, number>;
      groups: Array<{ name: string }>;
      opportunities: Array<{ name: string; calls: number; tokens_in_est: number; reason: string }>;
    };
    expect(data.scope.sessions).toBe(1);
    expect(data.funnel.compressed).toEqual({ calls: 1, tokens_in_est: 1000, tokens_out_est: 250, tokens_saved: 750, percent_all_tool_output: 750 / 1080 });
    expect(data.passthrough_reasons.no_compressor).toBe(1);
    expect(data.groups[0].name).toBe("grep");
    expect(data.opportunities[0]).toEqual({ name: "bash npm test", calls: 1, tokens_in_est: 80, reason: "no_compressor" });
  });

  test("legacy compression-only databases report scoped savings without a fabricated funnel", () => {
    const path = makeDb(true);
    addCompression(path, { session: "wanted", tool: "search", input: 900, output: 210, read: 1 });
    addCompression(path, { session: "wanted", tool: "file", input: 300, output: 75, cache: 1 });
    addCompression(path, { session: "other", input: 5000, output: 1 });
    const report = runGain(["--db", path, "--all", "--session", "wanted", "--by", "tool", "--no-rtk"], noRtk);
    expect(report).toContain("Calls table unavailable; funnel and passthrough sections omitted.");
    expect(report).toContain("Legacy compressions   2 records (1 compressed, 1 cache) · 1.2k → 285 tok   saved 915 · recalls 1");
    expect(report).toContain("By tool");
    expect(report).toContain("search");
    expect(report).not.toContain("5.0k");
    const data = JSON.parse(runGain(["--db", path, "--all", "--session", "wanted", "--by", "tool", "--json", "--no-rtk"], noRtk)) as Record<string, any>;
    expect(data.legacy_compressions).toEqual({ records: 2, compressed: 1, tokens_in_est: 1200, tokens_out_est: 285, tokens_saved: 915, cache_hits: 1, recalls: 1 });
    expect(data.groups.map(({ name, records, input, output }: any) => [name, records, input, output])).toEqual([["search", 1, 900, 210], ["file", 1, 300, 75]]);
    expect(data.funnel).toBeUndefined();
    expect(data.notes.some((note: string) => note.includes("reason"))).toBe(false);
    const reasons = JSON.parse(runGain(["--db", path, "--all", "--by", "reason", "--json", "--no-rtk"], noRtk)) as Record<string, any>;
    expect(reasons.legacy_compressions.reason_groups).toBe("unavailable");
    expect(reasons.groups).toBeUndefined();
    expect(reasons.notes.some((note: string) => note.includes("Call reasons are unavailable"))).toBe(true);
  });

  test("missing DB prints a helpful message and returns normally", () => {
    const report = runGain(["--db", join(tmpdir(), "qtk-does-not-exist.sqlite"), "--no-rtk"], noRtk);
    expect(report).toContain("No QTK stats database found");
    expect(report).toContain("Run QTK with a tool call first");
  });

  test("--usd uses requested model and only the corrected money format", () => {
    const path = makeDb();
    addCall(path, { outcome: "compressed", reason: "grep", input: 410_000, output: 0 });
    const low = runGain(["--db", path, "--all", "--usd", "--model", "claude-sonnet-4-5", "--no-rtk"], noRtk);
    expect(low).toContain("Assumed list prices for claude-sonnet-4-5: $1.23 saved");
    expect(low).not.toContain("Pricing model");
    const tinyPath = makeDb();
    addCall(tinyPath, { outcome: "compressed", reason: "grep", input: 1_000, output: 0 });
    expect(runGain(["--db", tinyPath, "--all", "--usd", "--no-rtk"], noRtk)).toContain("Assumed list prices for claude-sonnet-4-5: <$0.01 saved");
  });

  test("reports RTK's own summary from injected spawn data", () => {
    const path = makeDb();
    addCall(path, { outcome: "rtk", input: 10 });
    const report = runGain(["--db", path, "--all"], { ...noRtk, spawnRtk: () => ({ summary: { total_commands: 79, total_saved: 10_900, avg_savings_pct: 24.8 } }) });
    expect(report).toContain("RTK totals          79 runs · saved 10.9k (24.8%) · RTK's own count, all time, all projects");
    const projectReport = runGain(["--db", path, "--all", "--project", "/work/app"], { ...noRtk, spawnRtk: () => ({ summary: { total_commands: 2, total_saved: 200, avg_savings_pct: 50 } }) });
    expect(projectReport).toContain("RTK's own count, this project");
    const data = JSON.parse(runGain(["--db", path, "--all", "--json"], { ...noRtk, spawnRtk: () => ({ summary: { total_commands: 79, total_saved: 10_900, avg_savings_pct: 24.8 } }) })) as {
      rtk_totals: { total_commands: number; total_saved: number; avg_savings_pct: number; scope: string };
    };
    expect(data.rtk_totals).toEqual({ total_commands: 79, total_saved: 10_900, avg_savings_pct: 24.8, scope: "all time, all projects" });
    expect(runGain(["--db", path, "--all"], { ...noRtk, spawnRtk: () => { throw new Error("missing"); } })).toContain("handled by RTK");
    expect(runGain(["--db", path, "--all"], { ...noRtk, spawnRtk: () => { throw new Error("missing"); } })).not.toContain("RTK totals");
  });
});
