import type { PiRpcResponse } from "./RpcProcess.types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPiRpcResponse(message: unknown): message is PiRpcResponse {
  return isRecord(message) && message.type === "response" && typeof message.command === "string";
}
