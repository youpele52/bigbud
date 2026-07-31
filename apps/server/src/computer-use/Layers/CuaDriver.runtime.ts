import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { CuaDriverCallResult } from "../Services/CuaDriver.ts";

export interface CuaDriverSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly availableTools: ReadonlySet<string>;
  nextId: number;
}

export function requireCuaDriverEmbeddedHostBundleId(environment: NodeJS.ProcessEnv): string {
  const hostBundleId =
    environment.BIGBUD_CUA_HOST_BUNDLE_ID?.trim() ?? environment.CUA_DRIVER_HOST_BUNDLE_ID?.trim();
  if (!hostBundleId) {
    throw new Error("Embedded cua-driver MCP requires the Electron host bundle ID.");
  }
  return hostBundleId;
}

export function formatCuaDriverHealthReport(result: CuaDriverCallResult): string {
  const text = result.content
    .flatMap((block) => (typeof block.text === "string" ? [block.text] : []))
    .join("\n");
  return text || JSON.stringify(result.structuredContent ?? {}, null, 2);
}
