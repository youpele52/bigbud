/**
 * MCP clients launch bridge commands with a filtered environment. When the
 * desktop child executable is Electron, this flag keeps it in Node mode.
 */
export const ELECTRON_NODE_RUNTIME_ENV = {
  ELECTRON_RUN_AS_NODE: "1",
} as const;

export function resolveNodeExecutable(): string {
  return process.env.BIGBUD_NODE_EXECUTABLE?.trim() || process.execPath;
}
