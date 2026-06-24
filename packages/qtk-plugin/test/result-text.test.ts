import { describe, expect, test } from "bun:test";
import { extractResultText } from "../src/result-text.ts";

describe("result text extraction", () => {
  test("reads and writes normal opencode output strings", () => {
    const output = { output: "hello" };
    const target = extractResultText(output);

    expect(target?.shape).toBe("output");
    expect(target?.text).toBe("hello");
    target?.write("compressed");

    expect(output.output).toBe("compressed");
  });

  test("reads and writes MCP text content while preserving non-text content", () => {
    const output = {
      content: [
        { type: "text", text: "first" },
        { type: "image", mimeType: "image/png", data: "abc" },
        { type: "text", text: "second" },
      ],
    };
    const target = extractResultText(output);

    expect(target?.shape).toBe("mcp_text_content");
    expect(target?.text).toBe("first\n\nsecond");
    target?.write("compressed");

    expect(output.content).toEqual([
      { type: "text", text: "compressed" },
      { type: "image", mimeType: "image/png", data: "abc" },
    ]);
  });

  test("rewrites MCP resource text without dropping blobs", () => {
    const output = {
      content: [
        {
          type: "resource",
          resource: { uri: "file:///a.txt", text: "resource text", blob: "Zm9v" },
        },
      ],
    };
    const target = extractResultText(output);

    expect(target?.text).toBe("resource text");
    target?.write("compressed resource");

    expect(output.content[0]).toEqual({
      type: "resource",
      resource: {
        uri: "file:///a.txt",
        text: "compressed resource",
        blob: "Zm9v",
      },
    });
  });

  test("passes through non-text MCP content", () => {
    const output = { content: [{ type: "image", mimeType: "image/png" }] };
    expect(extractResultText(output)).toBeNull();
  });
});
