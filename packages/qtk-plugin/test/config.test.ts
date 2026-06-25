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

  test("loads feature opt-outs and disabled compressor lists", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        `
[qtk]
log_level = "debug"
dedup_ttl_seconds = 5

[qtk.rewrite]
enabled = false

[qtk.redaction]
enabled = false

[qtk.sidecar]
enabled = false

[qtk.filters]
disabled = ["project:noisy", "dsl:bundled:helm"]

[qtk.compressors.git_status]
enabled = false

[qtk.tools.read]
enabled = false
`,
      );

      const config = await loadConfig(root);

      expect(config.logLevel).toBe("debug");
      expect(config.dedupTtlSeconds).toBe(5);
      expect(config.rewrite.enabled).toBe(false);
      expect(config.redaction.enabled).toBe(false);
      expect(config.sidecar.enabled).toBe(false);
      expect(config.sidecar.requestTimeoutMs).toBe(1000);
      expect(config.filters.disabled).toEqual([
        "project:noisy",
        "dsl:bundled:helm",
      ]);
      expect(config.compressors["git-status"]?.enabled).toBe(false);
      expect(config.tools.read?.enabled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("merges global config before project config", async () => {
    const root = mkdtemp();
    const xdg = mkdtemp();
    const oldXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      mkdirSync(join(xdg, "qtk"), { recursive: true });
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(xdg, "qtk", "qtk.toml"),
        `
[qtk]
log_level = "debug"

[qtk.compression]
min_input_bytes = 123

[qtk.sidecar]
enabled = false
request_timeout_ms = 77

[qtk.compressors.rg]
max_files_shown = 4
`,
      );
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        `
[qtk]
log_level = "info"

[qtk.sidecar]
enabled = true

[qtk.compressors.rg]
max_matches_per_file = 2
`,
      );

      const config = await loadConfig(root);

      expect(config.logLevel).toBe("info");
      expect(config.compression.minInputBytes).toBe(123);
      expect(config.sidecar.enabled).toBe(true);
      expect(config.sidecar.requestTimeoutMs).toBe(77);
      expect(config.compressors.rg).toEqual({
        max_files_shown: 4,
        max_matches_per_file: 2,
      });
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      rmSync(root, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test("docs example qtk.toml parses as global config", async () => {
    const root = mkdtemp();
    const xdg = mkdtemp();
    const oldXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      mkdirSync(join(xdg, "qtk"), { recursive: true });
      const sample = await Bun.file(
        new URL("../../../docs/examples/qtk.toml", import.meta.url),
      ).text();
      writeFileSync(join(xdg, "qtk", "qtk.toml"), sample);

      const config = await loadConfig(root);

      expect(config.compression.minInputBytes).toBe(200);
      expect(config.sidecar.requestTimeoutMs).toBe(1000);
      expect(config.compressors["git-status"]?.max_files_per_section).toBe(15);
      expect(config.compressors["generic-text"]?.disabled_shapes).toEqual([]);
      expect(config.tools.read?.outline_threshold_lines).toBe(200);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      rmSync(root, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test("preserves # and commas inside quoted strings", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        `
[qtk.filters]
disabled = ["project:foo#bar", "dsl:bundled:a,b"]
`,
      );

      const config = await loadConfig(root);

      expect(config.filters.disabled).toEqual([
        "project:foo#bar",
        "dsl:bundled:a,b",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonicalizes hyphen and underscore table names when merging", async () => {
    const root = mkdtemp();
    const xdg = mkdtemp();
    const oldXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      mkdirSync(join(xdg, "qtk"), { recursive: true });
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(xdg, "qtk", "qtk.toml"),
        `
[qtk.compressors.git-status]
max_files_per_section = 1
`,
      );
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        `
[qtk.compressors.git_status]
max_files_per_section = 3
`,
      );

      const config = await loadConfig(root);

      expect(config.compressors["git-status"]?.max_files_per_section).toBe(3);
      expect(config.compressors.git_status).toBeUndefined();
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      rmSync(root, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});

function mkdtemp(): string {
  return join(tmpdir(), `qtk-config-test-${crypto.randomUUID()}`);
}
