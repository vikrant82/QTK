import { describe, expect, test } from "bun:test";
import { isTruthyEnv, rewriteCommand } from "../src/rewrite.ts";

describe("pre-call rewrite", () => {
  test("adds quiet flags to safe commands", () => {
    expect(rewriteCommand("pytest tests/unit")?.command).toBe(
      "pytest -q tests/unit",
    );
    expect(rewriteCommand("cargo test --all")?.command).toBe(
      "cargo test --quiet --all",
    );
    expect(rewriteCommand("npm install")?.command).toBe(
      "npm install --silent",
    );
    expect(rewriteCommand("pnpm i --frozen-lockfile")?.command).toBe(
      "pnpm i --silent --frozen-lockfile",
    );
  });

  test("skips verbose/debug commands", () => {
    for (const command of [
      "pytest -vv tests",
      "pytest -s tests",
      "pytest --debug tests",
      "cargo test -- --nocapture",
      "cargo build --verbose",
      "npm install --loglevel verbose",
    ]) {
      expect(rewriteCommand(command)).toBeNull();
    }
  });

  test("skips already quiet commands and shell compositions", () => {
    for (const command of [
      "pytest -q tests",
      "cargo check --quiet",
      "npm install --silent",
      "pytest tests | cat",
      "npm install && npm test",
    ]) {
      expect(rewriteCommand(command)).toBeNull();
    }
  });

  test("does not rewrite non-whitelisted commands", () => {
    expect(rewriteCommand("npm test")).toBeNull();
    expect(rewriteCommand("pnpm run build")).toBeNull();
    expect(rewriteCommand("git status")).toBeNull();
  });

  test("parses truthy env flags", () => {
    expect(isTruthyEnv("1")).toBe(true);
    expect(isTruthyEnv("true")).toBe(true);
    expect(isTruthyEnv("TRUE")).toBe(true);
    expect(isTruthyEnv("0")).toBe(false);
    expect(isTruthyEnv(undefined)).toBe(false);
  });
});
