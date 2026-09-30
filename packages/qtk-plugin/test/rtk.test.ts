import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRtkCommand,
  resolveRtkBinary,
  rtkRewrite,
  rtkRewriteAllowed,
  applyRtkRewrite,
  normalizeAgentRtkCommand,
  referencesRtkTee,
} from "../src/rtk.ts";

describe("RTK coordination helpers", () => {
  test.each([
    ["exit 3 rewrite", 3, "git status --short", { kind: "rewrite", command: "git status --short" }],
    ["exit 0 rewrite", 0, "git status --short", { kind: "rewrite", command: "git status --short" }],
    ["exit 1 declines", 1, "", { kind: "decline" }],
    ["exit 2 denies", 2, "", { kind: "deny" }],
    ["identical stdout", 3, "git status", { kind: "decline" }],
  ] as const)("%s", async (_name, exitCode, stdout, expected) => {
    const fixture = fakeRtk(`printf '%s' '${stdout}'; exit ${exitCode}`);
    try {
      expect(
        await rtkRewrite({
          binary: fixture.binary,
          command: "git status",
          cwd: fixture.root,
          timeoutMs: 1000,
        }),
      ).toEqual(expected);
      expect(await Bun.file(fixture.log).text()).toBe("rewrite\ngit status\n");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("kills a timed-out rewrite and returns within the deadline", async () => {
    const fixture = fakeRtk("sleep 5; printf 'git status --short'");
    const started = performance.now();
    try {
      expect(
        await rtkRewrite({
          binary: fixture.binary,
          command: "git status",
          cwd: fixture.root,
          timeoutMs: 200,
        }),
      ).toEqual({ kind: "decline" });
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("resolves only existing executable paths", () => {
    const fixture = fakeRtk("exit 0");
    try {
      expect(resolveRtkBinary(fixture.binary)).toBe(fixture.binary);
      expect(resolveRtkBinary(join(fixture.root, "missing"))).toBeNull();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test.each([
    ["rtk git status", true],
    ["FOO=1 rtk ls", true],
    ["cd x && rtk git diff | head", true],
    ["/opt/homebrew/bin/rtk git log", true],
    ["rg rtk src/", false],
    ["echo rtk", false],
    ["git status", false],
    ["grtk x", false],
  ])("recognizes RTK delegation in %s", (command, expected) => {
    expect(isRtkCommand(command)).toBe(expected);
  });

  test.each([
    ["rtk git status -s", ["git status"], true],
    ["rtk gofmt -w .", ["go"], false],
    ["echo hi && rtk git status", ["git status"], true],
    ["rtk git status && rtk git diff", ["git status"], false],
    ["rtk git status & rtk git diff", ["git status"], false],
    ["FOO=1 /opt/bin/rtk cargo test", ["cargo"], true],
    ["rtk git diff", ["*"], true],
    ["rtk git status", [], false],
    ["rtk git status 2>&1", ["git status"], true],
    ["rtk cargo test &> out.log", ["cargo"], true],
  ] as const)("allowlist checks each RTK segment: %s", (command, allow, expected) => {
    expect(rtkRewriteAllowed(command, allow)).toBe(expected);
  });

  test("default wildcard allows every RTK rewrite segment", () => {
    expect(applyRtkRewrite("git diff", "rtk git diff", ["*"], [])).toBe("rtk git diff");
    expect(applyRtkRewrite("rg foo", "rtk rg foo", ["*"], [])).toBe("rtk rg foo");
  });

  test("deny wins and preserves original segments independently", () => {
    expect(applyRtkRewrite("rg foo", "rtk rg foo", ["*"], ["rg"])).toBe("rg foo");
    expect(applyRtkRewrite("git status && rg foo", "rtk git status && rtk rg foo", ["*"], ["rg"])).toBe("rtk git status && rg foo");
  });

  test("agent-entered denied RTK proxy is stripped but native RTK commands stay intact", () => {
    expect(normalizeAgentRtkCommand("rtk rg foo", ["*"], ["rg"])).toBe("rg foo");
    expect(normalizeAgentRtkCommand("rtk read x", ["*"], ["rg"])).toBe("rtk read x");
  });

  test("segment-count mismatch falls back to the all-or-nothing policy", () => {
    expect(applyRtkRewrite("git status", "rtk git status && rtk rg foo", ["*"], [])).toBe("rtk git status && rtk rg foo");
    expect(applyRtkRewrite("git status", "rtk git status && rtk rg foo", ["*"], ["rg"])).toBe("git status");
    expect(applyRtkRewrite("git status", "rtk git status && rm -rf /", ["*"], [])).toBe("git status");
    expect(applyRtkRewrite("git status", "rtk git status && rtk rg foo", ["*"], [])).toBe("rtk git status && rtk rg foo");
  });

  test("quoted separators and embedded RTK text are not shell segment boundaries", () => {
    expect(normalizeAgentRtkCommand('echo "a; rtk rg x"', ["*"], ["rg"])).toBe('echo "a; rtk rg x"');
    expect(isRtkCommand('echo "rtk git status"')).toBe(false);
    expect(normalizeAgentRtkCommand('rtk rg x; echo "unterminated', ["*"], ["rg"])).toBe('rtk rg x; echo "unterminated');
    expect(applyRtkRewrite('rg x; echo "unterminated', 'rtk rg x; echo "unterminated', ["*"], [])).toBe('rg x; echo "unterminated');
  });

  test("heredoc bodies are ambiguous and never rewritten", () => {
    const command = "cat <<'EOF'\nrtk rg x\nEOF";
    expect(normalizeAgentRtkCommand(command, ["*"], ["rg"])).toBe(command);
    expect(applyRtkRewrite(command, "cat <<'EOF'\nrg x\nEOF", ["*"], ["rg"])).toBe(command);
  });

  test("detects platform-default and RTK-configured tee roots", () => {
    expect(referencesRtkTee("tail $HOME/Library/Application Support/rtk/tee/a.log", "/Users/test", "darwin")).toBe(true);
    expect(referencesRtkTee("/home/test/.local/share/rtk/tee/a.log", "/home/test", "linux")).toBe(true);
    expect(referencesRtkTee("/custom/rtk-logs/a.log", "/home/test", "linux", "/custom/data")).toBe(false);
  });

  test.each([
    ["sleep 1 & rtk git status", true],
    ["rtk git status 2>&1", true],
    ["rg foo 2>&1 | head", false],
  ] as const)("detects RTK commands across shell control operators: %s", (command, expected) => {
    expect(isRtkCommand(command)).toBe(expected);
  });
});

function fakeRtk(body: string): { root: string; binary: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "qtk-rtk-test-"));
  const binary = join(root, "rtk");
  const log = join(root, "argv.log");
  writeFileSync(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n${body}\n`,
  );
  chmodSync(binary, 0o755);
  return { root, binary, log };
}
