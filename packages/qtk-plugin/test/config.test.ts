import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

const oldStatsPath = process.env.QTK_STATS_PATH;
afterAll(() => {
  if (oldStatsPath === undefined) delete process.env.QTK_STATS_PATH;
  else process.env.QTK_STATS_PATH = oldStatsPath;
});

describe("config loader", () => {
  test("stats path precedence is env, config absolute/relative, then XDG default", async () => {
    const root = mkdtemp();
    const xdg = mkdtemp();
    const configHome = mkdtemp();
    const oldXdgData = process.env.XDG_DATA_HOME;
    const oldXdgConfig = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_DATA_HOME = xdg;
      process.env.XDG_CONFIG_HOME = configHome;
      delete process.env.QTK_STATS_PATH;
      expect((await loadConfig(root)).stats.database).toBe(join(xdg, "qtk", "stats.sqlite"));
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(join(root, ".opencode", "qtk.toml"), '[qtk.stats]\npath = "stats/custom.sqlite"\n');
      expect((await loadConfig(root)).stats.database).toBe(join(root, "stats/custom.sqlite"));
      writeFileSync(join(root, ".opencode", "qtk.toml"), '[qtk.stats]\npath = "/tmp/qtk-config.sqlite"\n');
      expect((await loadConfig(root)).stats.database).toBe("/tmp/qtk-config.sqlite");
      process.env.QTK_STATS_PATH = "/tmp/qtk-env.sqlite";
      expect((await loadConfig(root)).stats.database).toBe("/tmp/qtk-env.sqlite");
    } finally {
      if (oldXdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdgData;
      if (oldXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdgConfig;
      rmSync(root, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(configHome, { recursive: true, force: true });
    }
  });

  test("enables bundled and project filters by default", async () => {
    const root = mkdtemp();
    try {
      const config = await loadConfig(root);
      expect(config.filters.bundled).toBe(true);
      expect(config.filters.project).toBe(true);
      expect(config.rtk).toEqual(DEFAULT_CONFIG.rtk);
      expect(config.rtk.allow).toEqual(["*"]);
      expect(config.rtk.deny).toEqual([]);
      expect(config.compression.minSavingsRatio).toBe(0.1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses and bounds RTK rewrite configuration", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        '[qtk.rtk]\nenabled = false\nbinary = "/tmp/rtk"\nrewrite_timeout_ms = 20000\nallow = ["  git   diff ", "*"]\n',
      );

      const config = await loadConfig(root);

      expect(config.rtk).toEqual({
        enabled: false,
        binary: "/tmp/rtk",
        rewriteTimeoutMs: 10000,
        allow: ["git diff", "*"],
        deny: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clamps RTK rewrite timeout to its minimum", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        "[qtk.rtk]\nrewrite_timeout_ms = 1\n",
      );
      const config = await loadConfig(root);
      expect(config.rtk.rewriteTimeoutMs).toBe(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses and normalizes RTK allow prefixes", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        '[qtk.rtk]\nallow = ["  git   diff ", "*"]\n',
      );
      expect((await loadConfig(root)).rtk.allow).toEqual(["git diff", "*"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses normalized RTK deny prefixes", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(join(root, ".opencode", "qtk.toml"), '[qtk.rtk]\ndeny = [" rg  foo ", "git push"]\n');
      expect((await loadConfig(root)).rtk.deny).toEqual(["rg foo", "git push"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses and bounds the minimum final-text savings ratio", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        "[qtk.compression]\nmin_savings_ratio = 1.5\n",
      );
      expect((await loadConfig(root)).compression.minSavingsRatio).toBe(0.9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clamps the minimum final-text savings ratio to zero", async () => {
    const root = mkdtemp();
    try {
      mkdirSync(join(root, ".opencode"), { recursive: true });
      writeFileSync(
        join(root, ".opencode", "qtk.toml"),
        "[qtk.compression]\nmin_savings_ratio = -0.5\n",
      );
      expect((await loadConfig(root)).compression.minSavingsRatio).toBe(0);
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
path = "~/bin/qtk-core"
request_timeout_ms = 99

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
      expect(config.sidecar.path).toContain("/bin/qtk-core");
      expect(config.sidecar.requestTimeoutMs).toBe(99);
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
path = "/tmp/global-qtk-core"
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
path = ".opencode/plugin/qtk-core"

[qtk.compressors.rg]
max_matches_per_file = 2
`,
      );

      const config = await loadConfig(root);

      expect(config.logLevel).toBe("info");
      expect(config.compression.minInputBytes).toBe(123);
      expect(config.sidecar.enabled).toBe(true);
      expect(config.sidecar.path).toBe(join(root, ".opencode/plugin/qtk-core"));
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
      expect(config.sidecar.enabled).toBe(true);
      expect(config.sidecar.path).toBeNull();
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
