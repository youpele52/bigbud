import { CUA_DRIVER_VERSION } from "./release";

export interface CuaDriverManifest {
  readonly schema_version: "1";
  readonly binary_version: string;
  readonly binary_path: string;
  readonly mcp_invocation: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  };
}

export function parseCuaDriverManifest(value: unknown): CuaDriverManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Computer Use runtime manifest is not an object.");
  }
  const record = value as Record<string, unknown>;
  const invocation = record.mcp_invocation;
  if (
    record.schema_version !== "1" ||
    record.binary_version !== CUA_DRIVER_VERSION ||
    typeof record.binary_path !== "string" ||
    !invocation ||
    typeof invocation !== "object"
  ) {
    throw new Error("Computer Use runtime manifest does not match the pinned 0.9.1 contract.");
  }
  const invocationRecord = invocation as Record<string, unknown>;
  if (
    typeof invocationRecord.command !== "string" ||
    !Array.isArray(invocationRecord.args) ||
    !invocationRecord.args.every((arg) => typeof arg === "string") ||
    invocationRecord.args[0] !== "mcp"
  ) {
    throw new Error("Computer Use runtime manifest has an invalid MCP invocation.");
  }
  return value as CuaDriverManifest;
}
