import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeeWriter } from "../src/tee.ts";

describe("TeeWriter", () => {
  test("writes raw output when redaction is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "qtk-tee-raw-"));
    const raw = 'api_key = "sk-live-abcdefghijklmnopqrstuvwx"\n';
    try {
      const tee = new TeeWriter({
        projectRoot: root,
        teeDir: ".opencode/qtk-tee",
        redact: false,
      });

      const path = await tee.write("raw-output", raw);

      expect(path).not.toBeNull();
      expect(readFileSync(path!, "utf8")).toBe(raw);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["default", undefined],
    ["explicit true", true],
  ] as const)("redacts output when enabled by %s", async (_label, redact) => {
    const root = mkdtempSync(join(tmpdir(), "qtk-tee-redacted-"));
    const raw = 'api_key = "sk-live-abcdefghijklmnopqrstuvwx"\n';
    try {
      const tee = new TeeWriter({
        projectRoot: root,
        teeDir: ".opencode/qtk-tee",
        ...(redact === undefined ? {} : { redact }),
      });

      const path = await tee.write("redacted-output", raw);

      expect(path).not.toBeNull();
      const written = readFileSync(path!, "utf8");
      expect(written).not.toBe(raw);
      expect(written).toContain("[REDACTED_SECRET_VALUE]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
