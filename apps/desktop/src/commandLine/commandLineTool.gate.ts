/**
 * D2 decision gate: the Settings action is offered only where the packaged launcher has been
 * proven end to end. Windows joins once the native `.exe` launcher is proven on a real Windows install.
 * Dependency-free so the sandboxed preload can import it.
 */
const COMMAND_LINE_TOOL_VERIFIED_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux"]);

export function isCommandLineToolOffered(platform: string): boolean {
  return COMMAND_LINE_TOOL_VERIFIED_PLATFORMS.has(platform);
}
