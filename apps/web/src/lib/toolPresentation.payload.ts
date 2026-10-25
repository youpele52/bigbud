import { formatBigbudToolName } from "./toolPresentation";

export interface ToolPresentationIdentity {
  readonly rawName: string;
  readonly qualifiedName: string;
  readonly action?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function inputRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return record(value);
  if (value.length > 65_536) return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** Recover owned identities only from recognized provider envelopes, never arbitrary tool arguments. */
export function readOwnedToolPresentation(payload: unknown): ToolPresentationIdentity | undefined {
  const source = record(payload);
  const data = record(source?.data);
  const item = record(data?.item);
  const state = record(data?.state);
  let name: unknown;
  let namespace: unknown;
  let input: unknown;
  if (item && ["mcpToolCall", "dynamicToolCall"].includes(String(item.type))) {
    name = item.tool;
    namespace = item.namespace ?? item.server;
    input = item.arguments;
  } else if (data?.type === "tool" && state) {
    name = data.tool;
    input = state.input;
  } else if (data && Object.hasOwn(data, "toolName") && Object.hasOwn(data, "input")) {
    name = data.toolName;
    input = data.input;
  } else if (data && typeof data.name === "string" && typeof data.status === "string") {
    name = data.name;
    input = data.input;
  } else {
    return undefined;
  }
  if (typeof name !== "string") return undefined;
  const qualifiedName = typeof namespace === "string" ? `${namespace}: ${name}` : name;
  if (!formatBigbudToolName(qualifiedName)) return undefined;
  const action = inputRecord(input)?.action;
  return { rawName: name, qualifiedName, ...(typeof action === "string" ? { action } : {}) };
}
