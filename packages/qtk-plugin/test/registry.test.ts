import { describe, expect, test } from "bun:test";
import { CompressorRegistry } from "../src/registry.ts";

describe("CompressorRegistry opt-outs", () => {
  test("disables exact compressor names", () => {
    const registry = new CompressorRegistry();
    registry.disable(["git-status", "tool-read"]);

    expect(registry.names()).not.toContain("git-status");
    expect(registry.names()).not.toContain("tool-read");
    expect(registry.lookup("bash", { command: "git status" })?.name).not.toBe(
      "git-status",
    );
    expect(registry.lookup("read", {})?.name).not.toBe("tool-read");
  });

  test("removes compressors by prefix", () => {
    const registry = new CompressorRegistry([
      {
        name: "dsl:project:noisy",
        matches: () => true,
        compress: (raw) => raw,
      },
      {
        name: "git-status",
        matches: () => true,
        compress: (raw) => raw,
      },
    ]);

    registry.removeByPrefix(["dsl:project:"]);

    expect(registry.names()).toEqual(["git-status"]);
  });
});
