import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsTracker } from "../src/stats.ts";

describe("StatsTracker", () => {
  test("creates a fresh stats database with private permissions", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-mode-"));
    const path = join(root, "private", "stats.sqlite");
    try {
      const tracker = new StatsTracker(root, path);
      await tracker.init();
      tracker.close();
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tightens permissions on a pre-existing default global stats directory", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-xdg-mode-"));
    const oldXdg = process.env.XDG_DATA_HOME;
    const xdg = join(root, "xdg");
    const dir = join(xdg, "qtk");
    try {
      process.env.XDG_DATA_HOME = xdg;
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      chmodSync(dir, 0o755);
      const tracker = new StatsTracker(root, join(dir, "stats.sqlite"));
      await tracker.init();
      tracker.close();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdg;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("records result-shape/source/lossy metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-test-"));
    try {
      const tracker = new StatsTracker(root, ".opencode/qtk-stats.sqlite");
      await tracker.init();
      tracker.log({
        sessionID: "session-1",
        tool: "serena_get_diagnostics_for_file",
        commandHead: "serena_get_diagnostics_for_file",
        outcome: {
          compressor: "generic-text",
          compressorSource: "generic",
          resultShape: "mcp_text_content",
          isLossy: true,
          isGeneric: true,
          originalBytes: 1000,
          compressedBytes: 200,
          originalTokensEst: 250,
          compressedTokensEst: 50,
          ratio: 0.2,
          durationMs: 3,
          wasCacheHit: false,
          teeFile: ".opencode/qtk-tee/call.log",
        },
      });
      tracker.close();

      const db = new Database(join(root, ".opencode", "qtk-stats.sqlite"), {
        readonly: true,
      });
      const row = db.query("SELECT * FROM compressions").get() as Record<
        string,
        unknown
      >;
      expect(row.result_shape).toBe("mcp_text_content");
      expect(row.compressor_source).toBe("generic");
      expect(row.is_lossy).toBe(1);
      expect(row.is_generic).toBe(1);
      expect(row.project).toBe(root);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrates older stats databases", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-migrate-"));
    try {
      const dir = join(root, ".opencode");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "qtk-stats.sqlite");
      const db = new Database(path, { create: true });
      db.exec(`
        CREATE TABLE compressions (
          ts INTEGER NOT NULL,
          session_id TEXT,
          tool TEXT NOT NULL,
          command_head TEXT,
          compressor TEXT NOT NULL,
          original_bytes INTEGER NOT NULL,
          compressed_bytes INTEGER NOT NULL,
          original_tokens_est INTEGER NOT NULL,
          compressed_tokens_est INTEGER NOT NULL,
          ratio REAL NOT NULL,
          was_cache_hit INTEGER NOT NULL DEFAULT 0,
          tee_file TEXT,
          duration_ms INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.close();

      const tracker = new StatsTracker(root, ".opencode/qtk-stats.sqlite");
      await tracker.init();
      tracker.close();

      const migrated = new Database(path, { readonly: true });
      const columns = migrated.query("PRAGMA table_info(compressions)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain("result_shape");
      expect(columns.map((column) => column.name)).toContain("compressor_source");
      expect(columns.map((column) => column.name)).toContain("is_lossy");
      expect(columns.map((column) => column.name)).toContain("is_generic");
      expect(columns.map((column) => column.name)).toContain("agent_read_tee");
      expect(columns.map((column) => column.name)).toContain("agent_bypass_rerun");
      expect(columns.map((column) => column.name)).toContain("project");
      expect(migrated.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toContainEqual({ name: "calls" });
      migrated.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("logs call outcomes and prunes old rows on init", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-calls-"));
    const path = join(root, "stats.sqlite");
    try {
      const tracker = new StatsTracker(root, path, 1);
      await tracker.init();
      tracker.logCall({
        sessionID: "session", project: root, tool: "bash", commandHead: "git status",
        outcome: "passthrough", reason: "small", bytesIn: 4, bytesOut: 4,
        tokensInEst: 1, tokensOutEst: 1,
      });
      tracker.log(record("session", "bash", "git status", null));
      const db = new Database(path);
      db.query("UPDATE calls SET ts = 1").run();
      db.query("UPDATE compressions SET ts = 1").run();
      db.close();
      tracker.close();

      const next = new StatsTracker(root, path, 1);
      await next.init();
      next.logCall({
        sessionID: "session", project: root, tool: "bash", commandHead: "git status",
        outcome: "compressed", reason: "git-status", bytesIn: 100, bytesOut: 40,
        tokensInEst: 25, tokensOutEst: 10,
      });
      next.close();
      const check = new Database(path, { readonly: true });
      const rows = check.query("SELECT session_id, project, outcome, reason, bytes_in, bytes_out FROM calls").all();
      expect(rows).toEqual([{
        session_id: "session", project: root, outcome: "compressed", reason: "git-status",
        bytes_in: 100, bytes_out: 40,
      }]);
      expect(check.query("SELECT count(*) AS count FROM compressions").get()).toEqual({ count: 0 });
      check.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two trackers can write concurrently to one WAL database", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-wal-"));
    const path = join(root, "stats.sqlite");
    try {
      const first = new StatsTracker(root, path);
      const second = new StatsTracker(root, path);
      await first.init();
      await second.init();
      const make = (sessionID: string) => ({ sessionID, project: root, tool: "read", commandHead: null,
        outcome: "passthrough" as const, reason: "excluded", bytesIn: 1, bytesOut: 1, tokensInEst: 1, tokensOutEst: 1 });
      first.logCall(make("one"));
      second.logCall(make("two"));
      first.close();
      second.close();
      const db = new Database(path, { readonly: true });
      expect(db.query("SELECT session_id FROM calls ORDER BY session_id").all()).toEqual([{ session_id: "one" }, { session_id: "two" }]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("new databases include recall measurement columns", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-columns-"));
    try {
      const tracker = new StatsTracker(root, "stats.sqlite");
      await tracker.init();
      tracker.close();

      const db = new Database(join(root, "stats.sqlite"), { readonly: true });
      const columns = db.query("PRAGMA table_info(compressions)").all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain("agent_read_tee");
      expect(columns.map((column) => column.name)).toContain("agent_bypass_rerun");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("markTeeRead flags only rows with the matching tee path", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-tee-read-"));
    try {
      const tracker = new StatsTracker(root, "stats.sqlite");
      await tracker.init();
      tracker.log(record("s1", "tool-a", "cmd-a", "/tmp/tee-a"));
      tracker.log(record("s2", "tool-b", "cmd-b", "/tmp/tee-b"));
      tracker.markTeeRead("/tmp/tee-a");
      tracker.close();

      const db = new Database(join(root, "stats.sqlite"), { readonly: true });
      const rows = db.query(
        "SELECT tee_file, agent_read_tee FROM compressions ORDER BY rowid",
      ).all() as Array<{ tee_file: string; agent_read_tee: number }>;
      expect(rows).toEqual([
        { tee_file: "/tmp/tee-a", agent_read_tee: 1 },
        { tee_file: "/tmp/tee-b", agent_read_tee: 0 },
      ]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("markBypassRerun flags only the latest eligible row in the window", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-stats-bypass-"));
    try {
      const tracker = new StatsTracker(root, "stats.sqlite");
      await tracker.init();
      const sinceTs = Date.now();
      tracker.log(record("session", "tool", "command", null)); // old eligible
      tracker.log(record("session", "tool", "command", null)); // latest eligible
      tracker.log(record("other-session", "tool", "command", null));
      tracker.log(record("session", "tool", "other-command", null));
      tracker.log(record("session", "tool", "command", null, true));
      const dbPath = join(root, "stats.sqlite");
      const db = new Database(dbPath);
      db.query("UPDATE compressions SET ts = ? WHERE rowid = 1").run(sinceTs - 1);
      db.close();

      tracker.markBypassRerun("session", "tool", "command", sinceTs);
      tracker.markBypassRerun("missing", "tool", "command", sinceTs);
      tracker.close();

      const check = new Database(dbPath, { readonly: true });
      const rows = check.query(
        "SELECT rowid, agent_bypass_rerun FROM compressions ORDER BY rowid",
      ).all() as Array<{ rowid: number; agent_bypass_rerun: number }>;
      expect(rows).toEqual([
        { rowid: 1, agent_bypass_rerun: 0 },
        { rowid: 2, agent_bypass_rerun: 1 },
        { rowid: 3, agent_bypass_rerun: 0 },
        { rowid: 4, agent_bypass_rerun: 0 },
        { rowid: 5, agent_bypass_rerun: 0 },
      ]);
      check.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function record(
  sessionID: string,
  tool: string,
  commandHead: string,
  teeFile: string | null,
  wasCacheHit = false,
) {
  return {
    sessionID,
    tool,
    commandHead,
    outcome: {
      compressor: "test-compressor",
      originalBytes: 100,
      compressedBytes: 50,
      originalTokensEst: 25,
      compressedTokensEst: 10,
      ratio: 0.5,
      durationMs: 1,
      wasCacheHit,
      teeFile,
    },
  };
}
