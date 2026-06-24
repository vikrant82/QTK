import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("config loader", () => {
  test("enables bundled and project filters by default", async () => {
    const root = mkdtemp();
    try {
      const config = await loadConfig(root);
      expect(config.filters.bundled).toBe(true);
      expect(config.filters.project).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("can disable bundled or project filters", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        `[qtk.filters]\nbundled = false\nproject = false\n`,
      );

      const config = await loadConfig(root);
      expect(config.filters.bundled).toBe(false);
      expect(config.filters.project).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function mkdtemp(): string {
  return join(tmpdir(), `qtk-config-test-${crypto.randomUUID()}`);
}
