// `qtk gain` — summarize tool output handled by QTK and RTK.
//
// Usage:
//   bun packages/qtk-plugin/src/cli/gain.ts [--db PATH] [--days N|--all]
//     [--session ID] [--project [PATH]] [--by compressor|tool|command|project|reason]
//     [--json] [--usd --model ID] [--no-rtk]

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { formatUsd, lookupPricing, estimateUsdSaved } from "../pricing.ts";

type Outcome = "compressed" | "cache_hit" | "passthrough" | "rtk" | "bypass" | "recall";
type GroupBy = "compressor" | "tool" | "command" | "project" | "reason";

interface CallRow {
  id: number;
  ts: number;
  session_id: string;
  project: string;
  tool: string;
  command_head: string;
  outcome: Outcome;
  reason: string | null;
  bytes_in: number;
  bytes_out: number;
  tokens_in_est: number;
  tokens_out_est: number;
}

interface CompressionRow {
  ts: number;
  session_id: string;
  project?: string;
  tool?: string;
  command_head?: string;
  compressor: string;
  was_cache_hit: number;
  original_tokens_est: number;
  compressed_tokens_est: number;
  agent_read_tee?: number;
  agent_bypass_rerun?: number;
}

interface Options {
  now?: number;
  spawnRtk?: (cwd?: string) => unknown;
}

interface RtkSummary {
  total_commands: number;
  total_saved: number;
  avg_savings_pct: number;
}

const HELP = `Usage: qtk gain [--db PATH] [--days N | --all] [--session ID]
  [--project [PATH]] [--by compressor|tool|command|project|reason] [--json]
  [--usd --model ID] [--no-rtk] [--help]`;

function dbPath(args: string[]): string {
  const index = args.indexOf("--db");
  if (index >= 0) return resolve(args[index + 1] ?? "");
  const inline = args.find((arg) => arg.startsWith("--db="));
  if (inline) return resolve(inline.slice(5));
  if (process.env.QTK_STATS_PATH) return resolve(process.env.QTK_STATS_PATH);
  const base = process.env.XDG_DATA_HOME || resolve(process.env.HOME || ".", ".local/share");
  return resolve(base, "qtk", "stats.sqlite");
}

function numberArg(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  const raw = index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

function fmt(value: number): string {
  const n = Math.max(0, value);
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}

function columns(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function pathMatches(project: string, requested: string): boolean {
  if (!project) return false;
  let current = requested;
  while (true) {
    if (project === current) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function commandFamily(commandHead: string): string {
  let command = commandHead.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(command)) {
    command = command.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
  }
  command = command.replace(/^cd\s+\S+\s+&&\s+/, "");
  const words = command.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "(unknown)";
  if (words.length > 1 && !words[1]!.startsWith("-")) return `${words[0]} ${words[1]}`;
  return words[0]!;
}

function groupKey(row: { tool: string; command_head: string; project: string; reason: string | null; compressor?: string }, by: GroupBy): string {
  if (by === "tool") return row.tool || "unknown";
  if (by === "command") return row.command_head || "(unknown)";
  if (by === "project") return row.project || "(unknown)";
  if (by === "reason") return row.reason || "unknown";
  return row.reason || row.compressor || "unknown";
}

function reasonGroupKey(row: CallRow): string {
  const outcome = row.outcome === "cache_hit" ? "compressed" : row.outcome;
  return row.reason ? `${outcome}:${row.reason}` : outcome;
}

function fitLabel(label: string, width: number): string {
  const cap = Math.min(40, width);
  return label.length > cap ? `${label.slice(0, cap - 1)}…` : label;
}

function displayReason(reason: string): string {
  const labels: Record<string, string> = { kept_exact: "kept exact", fail_open: "fail-open", no_compressor: "no compressor", not_worth_it: "not worth it" };
  return labels[reason] ?? reason.replaceAll("_", " ");
}

function defaultSpawnRtk(cwd?: string): unknown {
  const args = ["gain", "--format", "json"];
  if (cwd) args.push("-p");
  const result = spawnSync("rtk", args, { cwd, encoding: "utf8", timeout: 3_000, shell: false });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function rtkSummary(value: unknown): RtkSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = (value as { summary?: unknown }).summary;
  if (!summary || typeof summary !== "object") return null;
  const fields = summary as Record<string, unknown>;
  const commands = fields.total_commands;
  const saved = fields.total_saved;
  const savings = fields.avg_savings_pct;
  if (typeof commands !== "number" || typeof saved !== "number" || typeof savings !== "number") return null;
  return { total_commands: commands, total_saved: saved, avg_savings_pct: savings };
}

function helpText(): string {
  return HELP;
}

export function runGain(argv: string[], options: Options = {}): string {
  if (argv.includes("--help")) return helpText();
  const path = dbPath(argv);
  if (!existsSync(path)) return `No QTK stats database found at ${path}. Run QTK with a tool call first, or pass --db PATH.`;
  const db = new Database(path, { readonly: true });
  try {
    const hasCalls = tableExists(db, "calls");
    const compressionCols = columns(db, "compressions");
    const hasProject = compressionCols.has("project") && (!hasCalls || columns(db, "calls").has("project"));
    const days = numberArg(argv, "--days", 7);
    const all = argv.includes("--all");
    const session = stringArg(argv, "--session");
    const wantsProject = argv.includes("--project");
    const projectFlagAt = argv.indexOf("--project");
    const projectRaw = wantsProject
      ? (argv[projectFlagAt + 1] && !argv[projectFlagAt + 1]!.startsWith("--") ? argv[projectFlagAt + 1] : process.cwd())
      : undefined;
    const requestedProjectPath = projectRaw ? resolve(projectRaw) : undefined;
    const groupByRaw = stringArg(argv, "--by") ?? "compressor";
    const allowed: GroupBy[] = ["compressor", "tool", "command", "project", "reason"];
    const by = allowed.includes(groupByRaw as GroupBy) ? groupByRaw as GroupBy : "compressor";
    const cutoff = all ? null : (options.now ?? Date.now()) - days * 86_400_000;
    const notes: string[] = [];
    if (!hasCalls) notes.push("Calls table unavailable; funnel and passthrough sections omitted.");
    if (!hasProject) notes.push("Project column unavailable; project grouping and project scope omitted.");
    if (!hasCalls && by === "reason") notes.push("Call reasons are unavailable in legacy compression-only databases.");
    if (wantsProject && !hasProject) return `${notes.join("\n")}\nProject filtering requires the project column.`;

    const compressions = db.query(`SELECT ts, session_id, ${compressionCols.has("project") ? "project" : "'' AS project"}, tool, command_head, compressor, original_tokens_est, compressed_tokens_est, was_cache_hit, ${compressionCols.has("agent_read_tee") ? "agent_read_tee" : "0 AS agent_read_tee"}, ${compressionCols.has("agent_bypass_rerun") ? "agent_bypass_rerun" : "0 AS agent_bypass_rerun"} FROM compressions`).all() as CompressionRow[];
    const compressionScopeRows = compressions.filter((row) =>
      (cutoff === null || row.ts >= cutoff) && (!session || row.session_id === session));
    let calls: CallRow[] = [];
    if (hasCalls) {
      calls = db.query("SELECT * FROM calls").all() as CallRow[];
      calls = calls.filter((row) => (cutoff === null || row.ts >= cutoff) && (!session || row.session_id === session));
    }
    const candidateProjects = [...new Set([
      ...compressionScopeRows.map((row) => row.project ?? ""),
      ...calls.map((row) => row.project ?? ""),
    ].filter((project) => project && requestedProjectPath && pathMatches(project, requestedProjectPath)))];
    const matchedProject = candidateProjects.sort((a, b) => b.length - a.length)[0];
    const projectPath = requestedProjectPath;
    const compressionRows = projectPath
      ? compressionScopeRows.filter((row) => row.project === matchedProject)
      : compressionScopeRows;
    if (projectPath) calls = calls.filter((row) => row.project === matchedProject);
    let rtk: RtkSummary | null = null;
    if (!argv.includes("--no-rtk")) {
      try {
        rtk = rtkSummary((options.spawnRtk ?? defaultSpawnRtk)(projectPath));
      } catch {
        // RTK is optional; its absence must not prevent QTK's report.
      }
    }
    const displayProjectPath = projectPath ? matchedProject ?? projectPath : undefined;
    const result = buildReport({ calls, compressionRows, cutoff, days, all, projectPath: displayProjectPath, by, notes, rtk, hasCalls, json: argv.includes("--json"), usd: argv.includes("--usd"), model: stringArg(argv, "--model") });
    return result;
  } finally {
    db.close();
  }
}

interface ReportInput {
  calls: CallRow[];
  compressionRows: CompressionRow[];
  cutoff: number | null;
  days: number;
  all: boolean;
  projectPath?: string;
  by: GroupBy;
  notes: string[];
  rtk: RtkSummary | null;
  hasCalls: boolean;
  json: boolean;
  usd: boolean;
  model?: string;
}

function buildReport(input: ReportInput): string {
  const { calls, compressionRows, cutoff, days, all, projectPath, by, notes, rtk } = input;
  const compressed = calls.filter((call) => call.outcome === "compressed" || call.outcome === "cache_hit");
  const passthrough = calls.filter((call) => call.outcome === "passthrough");
  const handledRtk = calls.filter((call) => call.outcome === "rtk");
  const recallCalls = calls.filter((call) => call.outcome === "recall");
  const recoveryCalls = calls.filter((call) => call.outcome === "bypass" || call.outcome === "recall");
  const qtkRecallCalls = recallCalls.filter((call) => call.reason === null);
  const rtkRecallCalls = recallCalls.filter((call) => call.reason === "rtk");
  const totalIn = calls.reduce((sum, call) => sum + call.tokens_in_est, 0);
  const compressedIn = compressed.reduce((sum, call) => sum + call.tokens_in_est, 0);
  const compressedOut = compressed.reduce((sum, call) => sum + call.tokens_out_est, 0);
  const saved = input.hasCalls ? compressedIn - compressedOut : compressionRows.reduce((sum, row) => sum + row.original_tokens_est - row.compressed_tokens_est, 0);
  const reasonCounts = new Map<string, number>();
  for (const call of passthrough) reasonCounts.set(call.reason ?? "unknown", (reasonCounts.get(call.reason ?? "unknown") ?? 0) + 1);
  const sortedReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const teeReads = compressionRows.filter((row) => row.was_cache_hit !== 1 && (row.agent_read_tee ?? 0) > 0).length;
  const bypassReruns = compressionRows.filter((row) => row.was_cache_hit !== 1 && (row.agent_bypass_rerun ?? 0) > 0).length;
  const recallRows = compressionRows.filter((row) => row.was_cache_hit !== 1 && ((row.agent_read_tee ?? 0) > 0 || (row.agent_bypass_rerun ?? 0) > 0)).length;
  // Calls are the canonical new event stream; retain compression metadata as
  // a fallback for older databases without call-level recall events.
  const qtkRecallCount = qtkRecallCalls.length || recallRows;
  const denominator = compressionRows.filter((row) => row.was_cache_hit !== 1).length;
  const aggregate = new Map<string, { calls: number; input: number; output: number }>();
  const groupedCalls = by === "reason" ? calls : compressed;
  for (const call of groupedCalls) {
    const name = by === "reason" ? reasonGroupKey(call) : groupKey(call, by);
    const value = aggregate.get(name) ?? { calls: 0, input: 0, output: 0 };
    value.calls += 1;
    value.input += call.tokens_in_est;
    value.output += call.tokens_out_est;
    aggregate.set(name, value);
  }
  if (!input.hasCalls && by !== "reason" && !(by === "project" && notes.some((note) => note.startsWith("Project column unavailable")))) for (const row of compressionRows) {
    const name = by === "tool" ? row.tool || "unknown" : by === "command" ? row.command_head || "(unknown)" : by === "project" ? row.project || "(unknown)" : row.compressor || "unknown";
    const value = aggregate.get(name) ?? { calls: 0, input: 0, output: 0 };
    value.calls++; value.input += row.original_tokens_est; value.output += row.compressed_tokens_est; aggregate.set(name, value);
  }
  const compressionByGroup = new Map<string, { total: number; recall: number }>();
  for (const row of compressionRows) {
    if (row.was_cache_hit === 1) continue;
    const name = by === "tool" ? row.tool || "unknown" : by === "command" ? row.command_head || "(unknown)" : by === "project" ? row.project || "(unknown)" : row.compressor || "unknown";
    const item = compressionByGroup.get(name) ?? { total: 0, recall: 0 };
    item.total += 1;
    if ((row.agent_read_tee ?? 0) > 0 || (row.agent_bypass_rerun ?? 0) > 0) item.recall += 1;
    compressionByGroup.set(name, item);
  }
  const groups = [...aggregate.entries()].map(([name, value]) => {
    const compression = compressionByGroup.get(name);
    return { name, ...value, saved: value.input - value.output, recall: compression?.recall ?? 0, recallDenominator: compression?.total ?? 0 };
  }).sort((a, b) => b.calls - a.calls || b.input - a.input || a.name.localeCompare(b.name));
  const opportunities = new Map<string, { calls: number; tokens_in_est: number; reasons: Map<string, number> }>();
  for (const call of passthrough.filter((row) => row.reason === "no_compressor" || row.reason === "fail_open")) {
    let key = call.tool || "unknown";
    if (key === "bash") key += ` ${commandFamily(call.command_head)}`;
    const value = opportunities.get(key) ?? { calls: 0, tokens_in_est: 0, reasons: new Map<string, number>() };
    value.calls += 1;
    value.tokens_in_est += call.tokens_in_est;
    value.reasons.set(call.reason!, (value.reasons.get(call.reason!) ?? 0) + 1);
    opportunities.set(key, value);
  }
  const topOpportunities = [...opportunities.entries()].map(([name, value]) => ({
    name, calls: value.calls, tokens_in_est: value.tokens_in_est,
    reason: [...value.reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "",
  }))
    .sort((a, b) => b.tokens_in_est - a.tokens_in_est || a.name.localeCompare(b.name)).slice(0, 5);
  const categoryCalls = compressed.length + handledRtk.length + recoveryCalls.length + passthrough.length;
  const legacyCompressionNote = input.hasCalls && compressionRows.length > compressed.length
    ? [`Calls/compressions mismatch: ${compressed.length} compressed call rows vs ${compressionRows.length} compression rows; legacy compression records may lack calls rows.`]
    : [];
  const reportNotes = [...notes, ...legacyCompressionNote];
  const legacy = { records: compressionRows.length, compressed: compressionRows.filter((row) => row.was_cache_hit !== 1).length, cache_hits: compressionRows.filter((row) => row.was_cache_hit === 1).length, tokens_in_est: compressionRows.reduce((sum, row) => sum + row.original_tokens_est, 0), tokens_out_est: compressionRows.reduce((sum, row) => sum + row.compressed_tokens_est, 0), recalls: recallRows };
  const rtkScopeLabel = projectPath ? "this project" : "all time, all projects";
  const window = { all, days: all ? null : days, since: cutoff };
  const scope = { project: projectPath ?? null, project_name: projectPath ? basename(projectPath) : null, sessions: new Set((input.hasCalls ? calls : compressionRows).map((row) => row.session_id)).size, projects: new Set((input.hasCalls ? calls.map((call) => call.project) : compressionRows.map((row) => row.project ?? "")).filter(Boolean)).size };
  const jsonData: Record<string, unknown> = {
    scope, window,
    rtk_totals: rtk ? { ...rtk, scope: rtkScopeLabel } : null, notes: reportNotes,
  };
  if (input.hasCalls && !(by === "project" && notes.some((note) => note.startsWith("Project column unavailable")))) {
    jsonData.funnel = { calls: calls.length, categories_total: categoryCalls, tokens_in_est: totalIn, compressed: { calls: compressed.length, tokens_in_est: compressedIn, tokens_out_est: compressedOut, tokens_saved: saved, percent_all_tool_output: totalIn ? saved / totalIn : 0 }, rtk: { calls: handledRtk.length, tokens_out_est: handledRtk.reduce((sum, call) => sum + call.tokens_out_est, 0) }, recovery: { calls: recoveryCalls.length, tokens_in_est: recoveryCalls.reduce((sum, call) => sum + call.tokens_in_est, 0), tokens_out_est: recoveryCalls.reduce((sum, call) => sum + call.tokens_out_est, 0) }, passthrough: { calls: passthrough.length, tokens_in_est: passthrough.reduce((sum, call) => sum + call.tokens_in_est, 0) } };
    jsonData.passthrough_reasons = Object.fromEntries(sortedReasons);
    jsonData.recalls = { qtk: { count: qtkRecallCount, denominator, tee_reads: teeReads, bypass_reruns: bypassReruns }, rtk: { count: rtkRecallCalls.length, denominator: handledRtk.length } };
    jsonData.groups = by === "reason"
      ? groups.map(({ name, calls: count, input, output }) => ({ name, calls: count, tokens_in_est: input, tokens_out_est: output }))
      : groups.map(({ recall: _recall, recallDenominator: _denominator, ...group }) => group);
    jsonData.opportunities = topOpportunities;
  }
  if (!input.hasCalls) { jsonData.legacy_compressions = { ...legacy, tokens_saved: legacy.tokens_in_est - legacy.tokens_out_est }; if (by === "reason") jsonData.legacy_compressions = { ...jsonData.legacy_compressions as object, reason_groups: "unavailable" }; if (by !== "reason" && !(by === "project" && notes.some((note) => note.startsWith("Project column unavailable")))) jsonData.groups = groups.map(({ recall: _r, recallDenominator: _d, calls: records, ...group }) => ({ ...group, records })); }
  if (input.json) return JSON.stringify(jsonData, null, 2);

  const scopeText = projectPath ? basename(projectPath) : "all projects";
  const head = `QTK · ${all ? "all time" : `last ${days} days`} · ${scopeText} (${scope.projects}) · ${scope.sessions} ${scope.sessions === 1 ? "session" : "sessions"}`;
  const lines = [head];
  if (!input.hasCalls && compressionRows.length) lines.push(`Legacy compressions   ${legacy.records} records (${legacy.compressed} compressed, ${legacy.cache_hits} cache) · ${fmt(legacy.tokens_in_est)} → ${fmt(legacy.tokens_out_est)} tok   saved ${fmt(legacy.tokens_in_est - legacy.tokens_out_est)} · recalls ${legacy.recalls}`);
  if (input.hasCalls && calls.length > 0) {
    lines.push(`Tool output seen    ${calls.length} ${plural(calls.length, "call")} · ${fmt(totalIn)} tok`);
    lines.push(`  compressed        ${String(compressed.length).padStart(3)} ${plural(compressed.length, "call")} · ${fmt(compressedIn)} → ${fmt(compressedOut)} tok   saved ${fmt(saved)} (${pct(totalIn ? saved / totalIn : 0)} of all tool output)`);
    lines.push(`  handled by RTK    ${String(handledRtk.length).padStart(3)} ${plural(handledRtk.length, "call")} · ${fmt(handledRtk.reduce((sum, call) => sum + call.tokens_out_est, 0))} tok out`);
    lines.push(`  recovery calls    ${String(recoveryCalls.length).padStart(3)} ${plural(recoveryCalls.length, "call")} · ${fmt(recoveryCalls.reduce((sum, call) => sum + call.tokens_in_est, 0))} tok`);
    lines.push(`  passed through    ${String(passthrough.length).padStart(3)} ${plural(passthrough.length, "call")} · ${fmt(passthrough.reduce((sum, call) => sum + call.tokens_in_est, 0))} tok`);
    if (sortedReasons.length) {
      const reasonLabels: Record<string, string> = { kept_exact: "kept exact", excluded: "excluded", no_compressor: "no compressor", fail_open: "fail-open", small: "small", not_worth_it: "not worth it" };
      lines.push(`    ${sortedReasons.map(([reason, count]) => `${reasonLabels[reason] ?? displayReason(reason)} ${count}`).join(" · ")}`);
    }
    const rtkRecallSummary = handledRtk.length > 0 || rtkRecallCalls.length > 0 ? ` · RTK ${rtkRecallCalls.length} of ${handledRtk.length} RTK ${plural(handledRtk.length, "call")}` : "";
    lines.push(`Recalls             QTK ${qtkRecallCount} of ${denominator} compressions (tee reads ${teeReads} · bypass reruns ${bypassReruns})${rtkRecallSummary}`);
  } else if (input.hasCalls && notes.length === 0) {
    lines.push("No tool calls recorded in the selected window.");
  }
  if (rtk) lines.push(`RTK totals          ${fmt(rtk.total_commands)} runs · saved ${fmt(rtk.total_saved)} (${pct(rtk.avg_savings_pct / 100)}) · RTK's own count, ${rtkScopeLabel}`);
  if (input.hasCalls && by === "reason") {
    lines.push("");
    const labelWidth = Math.min(40, Math.max("reason".length, ...groups.map((group) => group.name.length)));
    lines.push(`By reason ${"".padEnd(labelWidth - "reason".length)}  calls   tok in   tok out`);
    for (const group of groups) lines.push(`  ${fitLabel(group.name, labelWidth).padEnd(labelWidth)}  ${String(group.calls).padStart(4)}   ${fmt(group.input).padStart(6)}   ${fmt(group.output).padStart(6)}`);
  } else if ((input.hasCalls || (!input.hasCalls && by !== "reason")) && !(by === "project" && notes.some((note) => note.startsWith("Project column unavailable")))) {
    lines.push("");
    const title = `By ${by}`;
    const labelWidth = Math.min(40, Math.max(by.length, ...groups.map((group) => group.name.length)));
    lines.push(`${title} ${"".padEnd(labelWidth - by.length)}  ${input.hasCalls ? "calls" : "records"}   tok in → out   saved   recall`);
    for (const group of groups) lines.push(`  ${fitLabel(group.name, labelWidth).padEnd(labelWidth)}  ${String(group.calls).padStart(4)}   ${fmt(group.input).padStart(6)} → ${fmt(group.output).padEnd(6)} ${fmt(group.saved).padStart(6)}   ${pct(group.recallDenominator ? group.recall / group.recallDenominator : 0)}`);
  }
  if (input.usd) {
    const modelId = input.model ?? "claude-sonnet-4-5";
    const price = estimateUsdSaved(saved, lookupPricing(modelId));
    lines.push(`Assumed list prices for ${modelId}: ${formatUsd(price)} saved`);
  }
  if (topOpportunities.length > 0) {
    lines.push("");
    lines.push("Largest uncompressed (where to improve next)");
    for (const opportunity of topOpportunities) {
      const name = opportunity.name.length > 28 ? `${opportunity.name.slice(0, 27)}…` : opportunity.name;
      lines.push(`  ${name.padEnd(28)} ${String(opportunity.calls).padStart(3)} ${plural(opportunity.calls, "call")}  ${fmt(opportunity.tokens_in_est).padStart(6)} tok  ${displayReason(opportunity.reason)}`);
    }
  }
  if (reportNotes.length) lines.push(...reportNotes.map((note) => `Note: ${note}`));
  return lines.join("\n");
}

function main(): void {
  console.log(runGain(process.argv.slice(2)));
}

if (import.meta.main) main();
