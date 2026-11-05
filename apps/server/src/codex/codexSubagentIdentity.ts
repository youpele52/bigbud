/** Codex activity can target the root agent too; it is not a spawned child. */
export function isCodexSessionAgent(
  agentThreadId: string,
  sessionThreadId?: string,
  agentPath?: string,
): boolean {
  return agentThreadId === sessionThreadId || agentPath === "/root";
}
