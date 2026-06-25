import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../src/circuit-breaker.ts";
import { SessionCache } from "../src/cache.ts";
import { _internal } from "../src/index.ts";
import { CompressorRegistry } from "../src/registry.ts";
import { createQtkLogger } from "../src/logger.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { TeeWriter } from "../src/tee.ts";

function processContext(logs?: string[]) {
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
    logger: logs
      ? createQtkLogger({
          logLevel: "debug",
          sink: (line) => logs.push(line),
        })
      : createQtkLogger({ logLevel: "error" }),
    dedupTtlMs: 60_000,
    teeMode: "never" as const,
    redactionEnabled: true,
    config: DEFAULT_CONFIG,
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

  test("compresses MCP text content arrays in place", async () => {
    const raw = Array.from(
      { length: 40 },
      (_, i) => `src/service/file-${i}.ts`,
    ).join("\n");
    const output = {
      content: [
        { type: "text", text: raw },
        { type: "image", mimeType: "image/png", data: "abc" },
      ],
      metadata: {},
    };

    await _internal.processCall(
      { tool: "mcp_find", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        registry: new CompressorRegistry([
          {
            name: "mcp-path-list",
            category: "test",
            matches: (tool) => tool === "mcp_find",
            compress: (text) => `paths=${text.split("\n").length}`,
          },
        ]),
      },
    );

    expect(output.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("<qtk-compressed compressor=mcp-path-list"),
    });
    expect(output.content[0]!.text).toContain("paths=40");
    expect(output.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "abc",
    });
  });

  test("leaves non-text MCP content unchanged", async () => {
    const output = {
      content: [{ type: "image", mimeType: "image/png", data: "abc" }],
      metadata: {},
    };

    await _internal.processCall(
      { tool: "mcp_image", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(),
    );

    expect(output.content).toEqual([
      { type: "image", mimeType: "image/png", data: "abc" },
    ]);
  });

  test("redacts small pass-through output before the model sees it", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const output = { output: `AWS key leaked by a tool: ${secret}` };

    await _internal.processCall(
      { tool: "bash", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(),
    );

    expect(output.output).toContain("<qtk-redacted count=1>");
    expect(output.output).toContain("[REDACTED_SECRET_VALUE]");
    expect(output.output).not.toContain(secret);
    expect(output.output).not.toContain("<qtk-compressed");
  });

  test("redacts compressed output before mutation", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12";
    const raw = `${"noise line\n".repeat(80)}${secret}\n`;
    const output = { output: raw };

    await _internal.processCall(
      { tool: "mcp_secret", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        registry: new CompressorRegistry([
          {
            name: "secret-summary",
            category: "test",
            matches: (tool) => tool === "mcp_secret",
            compress: () => `summary token=${secret}`,
          },
        ]),
      },
    );

    expect(output.output).toContain("<qtk-redacted count=1>");
    expect(output.output).toContain("<qtk-compressed compressor=secret-summary");
    expect(output.output).toContain("summary token=[REDACTED_SECRET_VALUE]");
    expect(output.output).not.toContain(secret);
  });

  test("redacts MCP pass-through text when no compressor matches", async () => {
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890";
    const raw = `${"diagnostic line\n".repeat(30)}token=${secret}\n`;
    const output = { content: [{ type: "text", text: raw }], metadata: {} };

    await _internal.processCall(
      { tool: "mcp_plain", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        registry: new CompressorRegistry([]),
      },
    );

    expect(output.content[0]!.text).toContain("<qtk-redacted count=1>");
    expect(output.content[0]!.text).toContain("[REDACTED_SECRET_VALUE]");
    expect(output.content[0]!.text).not.toContain(secret);
  });

  test("can disable model-facing redaction in process context", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const output = { output: `AWS key leaked by a tool: ${secret}` };

    await _internal.processCall(
      { tool: "bash", sessionID: "session-test", callID: "call-test" },
      output,
      { ...processContext(), redactionEnabled: false },
    );

    expect(output.output).toBe(`AWS key leaked by a tool: ${secret}`);
  });

  test("honors per-call QTK_DISABLED bash env before redaction", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const output = { output: `AWS key leaked by a tool: ${secret}` };

    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-test",
        callID: "call-test",
        args: { command: "QTK_DISABLED=1 cat test_routes_handlers.py" },
      },
      output,
      processContext(),
    );

    expect(output.output).toBe(`AWS key leaked by a tool: ${secret}`);
  });

  test("disabled compressors pass through instead of compressing", async () => {
    const raw = await Bun.file(
      new URL("./fixtures/git/status-long.input.txt", import.meta.url),
    ).text();
    const registry = new CompressorRegistry();
    registry.disable(["git-status"]);
    const output = { output: raw, metadata: {} };

    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-test",
        callID: "call-test",
        args: { command: "git status" },
      },
      output,
      { ...processContext(), registry },
    );

    expect(output.output).toBe(raw);
  });

  test("generic MCP compression requires a recoverable tee", async () => {
    const raw = Array.from(
      { length: 60 },
      (_, i) => `packages/app/src/file-${i}.ts`,
    ).join("\n");
    const output = { content: [{ type: "text", text: raw }], metadata: {} };

    await _internal.processCall(
      { tool: "serena_get_diagnostics_for_file", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(),
    );

    expect(output.content[0]!.text).toBe(raw);
  });

  test("generic MCP compression writes lossy envelope with tee", async () => {
    const raw = Array.from(
      { length: 60 },
      (_, i) => `packages/app/src/file-${i}.ts`,
    ).join("\n");
    const output = { content: [{ type: "text", text: raw }], metadata: {} };

    await _internal.processCall(
      { tool: "serena_get_diagnostics_for_file", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(),
        tee: {
          write: async () => "/tmp/.opencode/qtk-tee/call-test.log",
        } as unknown as TeeWriter,
      },
    );

    expect(output.content[0]!.text).toContain("<qtk-compressed compressor=generic-text");
    expect(output.content[0]!.text).toContain("lossy=true");
    expect(output.content[0]!.text).toContain("tee=.opencode/qtk-tee/call-test.log");
  });

  test("generic cache hits preserve lossy tee metadata", async () => {
    const raw = Array.from(
      { length: 60 },
      (_, i) => `packages/app/src/file-${i}.ts`,
    ).join("\n");
    const cache = new SessionCache();
    const ctx = {
      ...processContext(),
      cache,
      tee: {
        write: async () => "/tmp/.opencode/qtk-tee/call-test.log",
      } as unknown as TeeWriter,
    };

    await _internal.processCall(
      { tool: "serena_get_diagnostics_for_file", sessionID: "session-test", callID: "call-test" },
      { content: [{ type: "text", text: raw }], metadata: {} },
      ctx,
    );

    const repeat = { content: [{ type: "text", text: raw }], metadata: {} };
    await _internal.processCall(
      { tool: "serena_get_diagnostics_for_file", sessionID: "session-test", callID: "call-test" },
      repeat,
      { ...ctx, tee: null },
    );

    expect(repeat.content[0]!.text).toContain("<qtk-unchanged");
    expect(repeat.content[0]!.text).toContain("lossy=true");
    expect(repeat.content[0]!.text).toContain("tee=.opencode/qtk-tee/call-test.log");
  });

  test("debug logger reports compression without raw output", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12";
    const raw = `${"safe but verbose line\n".repeat(80)}${secret}\n`;
    const logs: string[] = [];
    const output = { output: raw };

    await _internal.processCall(
      {
        tool: "bash",
        sessionID: "session-test",
        callID: "call-test",
        args: { command: `git status ${secret}` },
      },
      output,
      {
        ...processContext(logs),
        registry: new CompressorRegistry([
          {
            name: "safe-summary",
            category: "test",
            matches: () => true,
            compress: () => "summary only",
          },
        ]),
      },
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[qtk] compressed");
    expect(logs[0]).toContain("tool=bash");
    expect(logs[0]).toContain("compressor=safe-summary");
    expect(logs[0]).toContain("bytes=");
    expect(logs[0]).toContain("saved=");
    expect(logs[0]).not.toContain(secret);
    expect(logs[0]).not.toContain("safe but verbose line");
  });

  test("debug logger reports pass-through reasons", async () => {
    const logs: string[] = [];
    const raw = `${"diagnostic line\n".repeat(30)}`;
    const output = { output: raw };

    await _internal.processCall(
      { tool: "mcp_plain", sessionID: "session-test", callID: "call-test" },
      output,
      {
        ...processContext(logs),
        registry: new CompressorRegistry([]),
      },
    );

    expect(logs).toContainEqual(
      expect.stringContaining("[qtk] passthrough"),
    );
    expect(logs[0]).toContain("reason=no_match");
    expect(logs[0]).toContain("bytes=");
    expect(logs[0]).not.toContain("diagnostic line");
  });

  test("debug logger reports redactions without leaking values", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const logs: string[] = [];
    const output = { output: `secret=${secret}` };

    await _internal.processCall(
      { tool: "bash", sessionID: "session-test", callID: "call-test" },
      output,
      processContext(logs),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[qtk] redacted");
    expect(logs[0]).toContain("redactions=1");
    expect(logs[0]).not.toContain(secret);
  });
});
