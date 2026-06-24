import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../src/circuit-breaker.ts";
import { SessionCache } from "../src/cache.ts";
import { _internal } from "../src/index.ts";
import { CompressorRegistry } from "../src/registry.ts";

function processContext() {
  return {
    projectRoot: "/tmp",
    registry: new CompressorRegistry(),
    sidecarCompressors: [],
    cache: new SessionCache(),
    breaker: new CircuitBreaker(),
    tee: null,
    stats: null,
    savingsExporter: {
      setSessionId() {},
      setModelId() {},
      record() {},
    },
    dedupTtlMs: 60_000,
    teeMode: "never" as const,
  };
}

describe("opencode tool hook compatibility", () => {
  test("uses current opencode tool.execute.after input.args", async () => {
    const raw = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const output = { output: raw, metadata: {} };

    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-test",
        callID: "call-test",
        args: { command: "git status" },
      },
      output,
      processContext(),
    );

    expect(output.output).toContain("<qtk-compressed compressor=git-status");
    expect(output.output).toContain("branch=qalcode-offline-improvements");
    expect(output.output.length).toBeLessThan(raw.length);
  });

  test("keeps legacy output.metadata.args fallback", async () => {
    const raw = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const output = { output: raw, metadata: { args: { command: "git status" } } };

    await _internal.processCall(
      { tool: "bash", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(),
    );

    expect(output.output).toContain("<qtk-compressed compressor=git-status");
  });
});
