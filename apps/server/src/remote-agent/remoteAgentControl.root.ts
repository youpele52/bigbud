import { hasRemoteAgentPathControls } from "./remoteAgentRuntime.ts";

/** The control root a host reported; anything else is refused before any agent state is read. */
export function assertRemoteAgentControlRoot(root: string): void {
  if (
    !root.startsWith("/") ||
    !root.endsWith("/.bigbud/agent") ||
    hasRemoteAgentPathControls(root)
  ) {
    throw new Error("Invalid remote control root.");
  }
}
