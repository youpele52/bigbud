/** Bun's terminal API is Unix-only; Windows must use node-pty, including under Bun. */
export function terminalPtyBackend(
  platform: NodeJS.Platform,
  hasBunRuntime: boolean,
): "bun" | "node" {
  return hasBunRuntime && platform !== "win32" ? "bun" : "node";
}
