import type { CuaDriverCallResult } from "../Services/CuaDriver.ts";

export function toCallResult(result: unknown): CuaDriverCallResult {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const content = Array.isArray(record.content)
    ? record.content.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const block = entry as Record<string, unknown>;
        if (typeof block.type !== "string") {
          return [];
        }
        return [
          {
            type: block.type,
            ...(typeof block.text === "string" ? { text: block.text } : {}),
            ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
            ...(typeof block.data === "string" ? { data: block.data } : {}),
          },
        ];
      })
    : [];
  if (record.isError === true) {
    const message = content.find((entry) => entry.text)?.text;
    throw new Error(message ?? "cua-driver reported an MCP tool error.");
  }
  return {
    content,
    ...(record.structuredContent === undefined
      ? {}
      : { structuredContent: record.structuredContent }),
  };
}

export function parseAvailableTools(result: unknown): ReadonlySet<string> {
  if (!result || typeof result !== "object") return new Set();
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return new Set();
  return new Set(
    tools.flatMap((tool) =>
      tool && typeof tool === "object" && typeof tool.name === "string" ? [tool.name] : [],
    ),
  );
}
