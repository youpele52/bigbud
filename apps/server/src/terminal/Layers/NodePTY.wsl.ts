import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";

/** Always quote data, including already-quoted values, using Windows CRT argv rules. */
function quoteWindowsArg(value: string): string {
  if (value.includes("\0")) throw new Error("Invalid WSL terminal argument.");
  const escaped = value
    .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/\\+$/g, (slashes) => slashes + slashes);
  return `"${escaped}"`;
}

/** Bypass node-pty's already-quoted array heuristic only for explicit Windows WSL sessions. */
export function terminalNodePtyArgs(
  args: string[],
  executionTargetId: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | string[] {
  return platform === "win32" && isWslTerminalTargetId(executionTargetId)
    ? args.map(quoteWindowsArg).join(" ")
    : args;
}
