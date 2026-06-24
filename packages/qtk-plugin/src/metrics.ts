export type CompressorSource =
  | "builtin"
  | "tool"
  | "bundled-filter"
  | "project-filter"
  | "generic"
  | "sidecar"
  | "session-cache";

export type ResultShape = "output" | "mcp_text_content" | "unknown";

export function classifyCompressorSource(compressor: string): CompressorSource {
  if (compressor === "session-cache") return "session-cache";
  if (compressor.startsWith("tool-")) return "tool";
  if (compressor.startsWith("dsl:bundled:")) return "bundled-filter";
  if (compressor.startsWith("dsl:project:")) return "project-filter";
  if (compressor.startsWith("dsl:")) return "project-filter";
  if (compressor.startsWith("generic-")) return "generic";
  if (compressor.startsWith("sidecar:")) return "sidecar";
  return "builtin";
}

export function isGenericCompressor(compressor: string): boolean {
  return compressor.startsWith("generic-");
}
