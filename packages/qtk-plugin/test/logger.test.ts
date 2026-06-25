import { describe, expect, test } from "bun:test";
import {
  createQtkLogger,
  formatArrow,
  formatBytes,
  formatRatioSaved,
  sanitizeLogLabel,
} from "../src/logger.ts";

describe("QTK debug logger", () => {
  test("is disabled unless debug log level or env is set", () => {
    const logs: string[] = [];
    createQtkLogger({ logLevel: "info", sink: (line) => logs.push(line) })
      .debug("compressed", { tool: "bash" });

    expect(logs).toEqual([]);
  });

  test("can be enabled by QTK_DEBUG-style env", () => {
    const logs: string[] = [];
    createQtkLogger({
      logLevel: "info",
      debugEnv: "1",
      sink: (line) => logs.push(line),
    }).debug("compressed", { tool: "bash", bytes: "2.0kB→512B" });

    expect(logs).toEqual(["[qtk] compressed tool=bash bytes=2.0kB→512B"]);
  });

  test("sanitizes labels and logger fields", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12";
    const logs: string[] = [];
    const logger = createQtkLogger({
      logLevel: "debug",
      sink: (line) => logs.push(line),
    });

    logger.debug("rewrite", { cmd: `git status ${secret}` });

    expect(logs[0]).toContain("[REDACTED]");
    expect(logs[0]).not.toContain(secret);
    expect(sanitizeLogLabel(`git status ${secret}`)).toBe("git status [REDACTED]");
  });

  test("formats sizes and savings", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0kB");
    expect(formatArrow("2.0kB", "512B")).toBe("2.0kB→512B");
    expect(formatRatioSaved(2000, 500)).toBe("75.0%");
  });
});
