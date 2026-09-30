// SQLite stats tracker. Strictly local — see SECURITY.md §2.
//
// Uses bun:sqlite (built into Bun, zero deps). Writes are best-effort
// fire-and-forget; if the DB is locked or write fails, we log and move on
// rather than blocking the agent loop.

import { Database } from "bun:sqlite";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { chmod, mkdir } from "node:fs/promises";
import type { CompressionOutcome } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compressions (
  ts                       INTEGER NOT NULL,
  session_id               TEXT,
  tool                     TEXT NOT NULL,
  command_head             TEXT,
  compressor               TEXT NOT NULL,
  original_bytes           INTEGER NOT NULL,
  compressed_bytes         INTEGER NOT NULL,
  original_tokens_est      INTEGER NOT NULL,
  compressed_tokens_est    INTEGER NOT NULL,
  ratio                    REAL NOT NULL,
  was_cache_hit            INTEGER NOT NULL DEFAULT 0,
  tee_file                 TEXT,
  agent_read_tee           INTEGER NOT NULL DEFAULT 0,
  agent_bypass_rerun       INTEGER NOT NULL DEFAULT 0,
  duration_ms              INTEGER NOT NULL DEFAULT 0,
  result_shape             TEXT NOT NULL DEFAULT 'output',
  compressor_source        TEXT NOT NULL DEFAULT 'builtin',
  is_lossy                 INTEGER NOT NULL DEFAULT 0,
  is_generic               INTEGER NOT NULL DEFAULT 0,
  project                  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_session ON compressions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool ON compressions(tool);
CREATE INDEX IF NOT EXISTS idx_ts ON compressions(ts);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  tool TEXT NOT NULL,
  command_head TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  bytes_in INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  tokens_in_est INTEGER NOT NULL,
  tokens_out_est INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE INDEX IF NOT EXISTS calls_project_ts ON calls(project, ts);
`;

export interface StatsRecord {
  readonly sessionID: string;
  readonly tool: string;
  readonly commandHead: string;
  readonly outcome: CompressionOutcome;
}

export interface CallRecord {
  readonly sessionID: string;
  readonly project: string;
  readonly tool: string;
  readonly commandHead: string | null;
  readonly outcome: "compressed" | "cache_hit" | "passthrough" | "rtk" | "bypass" | "recall";
  readonly reason: string | null;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly tokensInEst: number;
  readonly tokensOutEst: number;
}

/** Best-effort SQLite telemetry; writes wait at most 250ms on contention and never escape hook calls. */
export class StatsTracker {
  private db: Database | null = null;
  private insertStmt: ReturnType<Database["prepare"]> | null = null;
  private dbPath: string;
  private readonly project: string;
  private readonly isDefaultGlobalPath: boolean;

  /** Resolve the database and project attribution; database failures are deferred to init and swallowed there. */
  constructor(projectRoot: string, dbPath: string, private readonly retentionDays = 90) {
    this.project = resolve(projectRoot);
    this.dbPath = resolve(projectRoot, dbPath);
    const dataHome = process.env.XDG_DATA_HOME || resolve(homedir(), ".local", "share");
    this.isDefaultGlobalPath = this.dbPath === resolve(dataHome, "qtk", "stats.sqlite");
  }

  /** Open/migrate/prune the shared database; failures disable telemetry without throwing into plugin initialization. */
  async init(): Promise<void> {
    try {
      await mkdir(dirname(this.dbPath), { recursive: true, mode: 0o700 });
      if (this.isDefaultGlobalPath) {
        try {
          await chmod(dirname(this.dbPath), 0o700);
        } catch (e) {
          console.warn(`[qtk] stats: chmod failed for ${dirname(this.dbPath)}:`, e);
        }
      }
      this.db = new Database(this.dbPath, { create: true });
      // WAL mode for better concurrency (multiple sessions might write).
      this.db.exec("PRAGMA journal_mode = WAL;");
      await this.chmodDatabaseFiles();
      this.db.exec("PRAGMA busy_timeout = 250;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec(SCHEMA);
      ensureColumn(this.db, "result_shape", "TEXT NOT NULL DEFAULT 'output'");
      ensureColumn(
        this.db,
        "compressor_source",
        "TEXT NOT NULL DEFAULT 'builtin'",
      );
      ensureColumn(this.db, "is_lossy", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(this.db, "is_generic", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(this.db, "agent_read_tee", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(this.db, "agent_bypass_rerun", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(this.db, "project", "TEXT NOT NULL DEFAULT ''");
      if (this.retentionDays > 0) {
        const cutoff = Date.now() - this.retentionDays * 86_400_000;
        this.db.query("DELETE FROM calls WHERE ts < ?").run(cutoff);
        this.db.query("DELETE FROM compressions WHERE ts < ?").run(cutoff);
      }
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_result_shape ON compressions(result_shape);",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_compressor_source ON compressions(compressor_source);",
      );
      this.insertStmt = this.db.prepare(`
        INSERT INTO compressions (
          ts, session_id, tool, command_head, compressor,
          original_bytes, compressed_bytes,
          original_tokens_est, compressed_tokens_est,
          ratio, was_cache_hit, tee_file, duration_ms,
          result_shape, compressor_source, is_lossy, is_generic, project
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      await this.chmodDatabaseFiles();
    } catch (e) {
      console.warn(`[qtk] stats: init failed for ${this.dbPath}:`, e);
      this.db = null;
      this.insertStmt = null;
    }
  }

  private async chmodDatabaseFiles(): Promise<void> {
    for (const path of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      try {
        await chmod(path, 0o600);
      } catch (e) {
        console.warn(`[qtk] stats: chmod failed for ${path}:`, e);
      }
    }
  }

  /** Synchronously append a compression row; call order is connection-local and write failures are warned, not thrown. */
  log(rec: StatsRecord): void {
    if (!this.insertStmt) return;
    try {
      this.insertStmt.run(
        Date.now(),
        rec.sessionID,
        rec.tool,
        rec.commandHead,
        rec.outcome.compressor,
        rec.outcome.originalBytes,
        rec.outcome.compressedBytes,
        rec.outcome.originalTokensEst,
        rec.outcome.compressedTokensEst,
        rec.outcome.ratio,
        rec.outcome.wasCacheHit ? 1 : 0,
        rec.outcome.teeFile,
        rec.outcome.durationMs,
        rec.outcome.resultShape ?? "output",
        rec.outcome.compressorSource ?? "builtin",
        rec.outcome.isLossy ? 1 : 0,
        rec.outcome.isGeneric ? 1 : 0,
        this.project,
      );
    } catch (e) {
      if (isSqliteBusy(e)) console.debug("[qtk] stats: compression write dropped (database busy)");
      else console.warn(`[qtk] stats: insert failed:`, e);
    }
  }

  /** Append one after-hook result in call order on this connection; write failures are warned and never thrown. */
  logCall(rec: CallRecord): void {
    if (!this.db) return;
    try {
      this.db.query(`INSERT INTO calls (
        ts, session_id, project, tool, command_head, outcome, reason,
        bytes_in, bytes_out, tokens_in_est, tokens_out_est
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        Date.now(), rec.sessionID, this.project, rec.tool, rec.commandHead,
        rec.outcome, rec.reason, rec.bytesIn, rec.bytesOut,
        rec.tokensInEst, rec.tokensOutEst,
      );
    } catch (e) {
      if (isSqliteBusy(e)) console.debug("[qtk] stats: call write dropped (database busy)");
      else console.warn("[qtk] stats: call insert failed:", e);
    }
  }

  /**
   * Mark every compression row for an absolute tee path as read. SQLite
   * operations and `log()` inserts are synchronous on this tracker connection,
   * so call order is preserved; database failures are warned and never escape
   * into the hook.
   */
  markTeeRead(teeFile: string): void {
    if (!this.db) return;
    try {
      this.db.query(
        "UPDATE compressions SET agent_read_tee = 1 WHERE tee_file = ?",
      ).run(teeFile);
    } catch (e) {
      if (isSqliteBusy(e)) console.debug("[qtk] stats: tee-read update dropped (database busy)");
      else console.warn("[qtk] stats: tee-read update failed:", e);
    }
  }

  /**
   * Mark only the newest eligible compression row in the session/tool/command
   * window. `sinceTs` is Unix epoch milliseconds, matching `ts` from `Date.now()`.
   * Updates are synchronous and ordered with `log()` on this connection; no
   * match is a no-op, and database failures are warned rather than thrown.
   */
  markBypassRerun(
    sessionID: string,
    tool: string,
    commandHead: string,
    sinceTs: number,
  ): void {
    if (!this.db) return;
    try {
      this.db.query(`
        UPDATE compressions
        SET agent_bypass_rerun = 1
        WHERE rowid = (
          SELECT rowid FROM compressions
          WHERE session_id = ? AND tool = ? AND command_head = ?
            AND was_cache_hit = 0 AND ts >= ?
          ORDER BY ts DESC, rowid DESC
          LIMIT 1
        )
      `).run(sessionID, tool, commandHead, sinceTs);
    } catch (e) {
      if (isSqliteBusy(e)) console.debug("[qtk] stats: bypass-rerun update dropped (database busy)");
      else console.warn("[qtk] stats: bypass-rerun update failed:", e);
    }
  }

  /** Close this connection best-effort; repeated calls are safe and do not throw. */
  close(): void {
    try {
      this.db?.close();
    } catch {
      /* best effort */
    }
    this.db = null;
    this.insertStmt = null;
  }
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}

function ensureColumn(db: Database, name: string, definition: string): void {
  const rows = db.query("PRAGMA table_info(compressions)").all() as Array<{
    name: string;
  }>;
  if (rows.some((row) => row.name === name)) return;
  db.exec(`ALTER TABLE compressions ADD COLUMN ${name} ${definition};`);
}

/**
 * Extract the first 3 tokens of a command line for privacy-preserving
 * stats storage. E.g. `git status --short` → `git status --short`,
 * `cargo test --no-run` → `cargo test --no-run`. Args after the third
 * token are dropped to avoid storing file paths or other potentially
 * sensitive data.
 */
export function commandHead(command: string): string {
  return command.trim().split(/\s+/).slice(0, 3).join(" ");
}
