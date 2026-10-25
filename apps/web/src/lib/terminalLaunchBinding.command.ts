import type { NativeApi } from "@bigbud/contracts/server/ipc.nativeApi.ts";
import { DEFAULT_TERMINAL_ID } from "@bigbud/contracts/constants/terminal.constant.ts";
import type { TerminalOpenInput } from "@bigbud/contracts/workspace/terminal.ts";
import {
  assertTerminalCommandContext,
  terminalCommandContextMatches,
} from "@bigbud/shared/terminalCommand";
import {
  bindTerminalLaunch,
  readTerminalLaunch,
  recordTerminalLaunch,
} from "./terminalLaunchBinding";

interface TerminalCommandInput {
  openInput: TerminalOpenInput;
  command: string;
  preferNewTerminal: boolean;
  baseTerminalBusy: boolean;
  newTerminalDimensions?: { cols: number; rows: number };
  createTerminalId: () => string;
  onTerminalSelected: (input: TerminalOpenInput & { terminalId: string }, isNew: boolean) => void;
}

/** Preserve retained sessions; only a verified matching launch can receive the command. */
export async function runBoundTerminalCommand(
  terminal: Pick<NativeApi["terminal"], "open" | "write">,
  input: TerminalCommandInput,
): Promise<void> {
  const desired = input.openInput;
  const baseTerminalId = desired.terminalId ?? DEFAULT_TERMINAL_ID;
  const bound = readTerminalLaunch(desired.threadId, baseTerminalId);
  const matching =
    bound && terminalCommandContextMatches({ ...bound, env: bound.runtimeEnv }, desired);
  const isNew = input.preferNewTerminal || input.baseTerminalBusy || !matching;
  const openInput = {
    ...desired,
    ...(isNew ? input.newTerminalDimensions : {}),
    terminalId: isNew ? input.createTerminalId() : baseTerminalId,
  };
  bindTerminalLaunch(openInput.threadId, openInput.terminalId, {
    cwd: openInput.cwd,
    worktreePath: openInput.worktreePath,
    executionTargetId: openInput.executionTargetId,
    runtimeEnv: openInput.env,
  });
  // Bind before mounting a viewport so concurrent opens use the command's launch context.
  input.onTerminalSelected(openInput, isNew);
  const opened = await terminal.open(openInput);
  recordTerminalLaunch(opened);
  assertTerminalCommandContext(opened, openInput);
  await terminal.write({
    threadId: openInput.threadId,
    terminalId: openInput.terminalId,
    data: `${input.command}\r`,
  });
}
