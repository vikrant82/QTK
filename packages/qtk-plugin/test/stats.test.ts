import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsTracker } from "../src/stats.ts";

describe("StatsTracker", () => {
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
          agent_read_tee INTEGER NOT NULL DEFAULT 0,
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
      migrated.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
