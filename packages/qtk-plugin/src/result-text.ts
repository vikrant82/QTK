// Result text extraction/mutation for opencode tool hook outputs.
//
// Built-in opencode tools pass `{ output: string }` to `tool.execute.after`.
// MCP tools pass their raw content array first; opencode flattens text content
// into `{ output }` after plugin hooks run. QTK therefore needs to mutate the
// same shape it received.

export type ResultTextShape = "output" | "mcp_text_content";

export interface ResultTextTarget {
  readonly text: string;
  readonly shape: ResultTextShape;
  write(text: string): void;
}

export function extractResultText(output: unknown): ResultTextTarget | null {
  if (!isRecord(output)) return null;

  if (typeof output.output === "string") {
    return {
      text: output.output,
      shape: "output",
      write(text: string) {
        output.output = text;
      },
    };
  }

  if (Array.isArray(output.content)) return extractContentText(output);
  return null;
}

function extractContentText(output: Record<string, unknown>): ResultTextTarget | null {
  const content = output.content;
  if (!Array.isArray(content)) return null;

  const textEntries: TextEntry[] = [];
  const parts: string[] = [];
  for (let index = 0; index < content.length; index++) {
    const item = content[index];
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      textEntries.push({ index, kind: "text" });
      parts.push(item.text);
      continue;
    }
    if (item.type === "resource" && isRecord(item.resource)) {
      const resource = item.resource;
      if (typeof resource.text === "string") {
        textEntries.push({ index, kind: "resource" });
        parts.push(resource.text);
      }
    }
  }

  if (textEntries.length === 0 || parts.every((part) => part.length === 0)) {
    return null;
  }

  return {
    text: parts.join("\n\n"),
    shape: "mcp_text_content",
    write(text: string) {
      output.content = rewriteContentText(content, textEntries, text);
    },
  };
}

type TextEntry = {
  readonly index: number;
  readonly kind: "text" | "resource";
};

function rewriteContentText(
  content: unknown[],
  textEntries: readonly TextEntry[],
  text: string,
): unknown[] {
  let wrote = false;
  const entryIndexes = new Set(textEntries.map((entry) => entry.index));
  const rewritten: unknown[] = [];

  for (let index = 0; index < content.length; index++) {
    const item = content[index];
    if (!entryIndexes.has(index)) {
      rewritten.push(item);
      continue;
    }
    if (wrote) {
      // Drop later text-only content items so opencode does not re-add the raw
      // text after the compressed envelope. Resource items may carry blobs, so
      // preserve them but remove only their text field.
      const entry = textEntries.find((candidate) => candidate.index === index);
      if (entry?.kind === "resource" && isRecord(item) && isRecord(item.resource)) {
        const resource = { ...item.resource };
        delete resource.text;
        rewritten.push({ ...item, resource });
      }
      continue;
    }
    wrote = true;
    const entry = textEntries.find((candidate) => candidate.index === index);
    if (entry?.kind === "resource" && isRecord(item) && isRecord(item.resource)) {
      rewritten.push({ ...item, resource: { ...item.resource, text } });
    } else if (isRecord(item)) {
      rewritten.push({ ...item, text });
    } else {
      rewritten.push(item);
    }
  }

  return rewritten;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
