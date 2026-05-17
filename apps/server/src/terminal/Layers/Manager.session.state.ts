import { type TerminalSessionState } from "./Manager.types";

export function resetSessionRuntimeState(session: TerminalSessionState): void {
  session.history = "";
  session.pendingHistoryControlSequence = "";
  session.pendingProcessEvents = [];
  session.pendingProcessEventIndex = 0;
  session.processEventDrainRunning = false;
}

export function createTerminalSessionState(input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly history: string;
  readonly cols: number;
  readonly rows: number;
  readonly runtimeEnv: Record<string, string> | null;
}): TerminalSessionState {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId,
    executionTargetId: input.executionTargetId,
    cwd: input.cwd,
    worktreePath: input.worktreePath,
    status: "starting",
    pid: null,
    history: input.history,
    pendingHistoryControlSequence: "",
    pendingProcessEvents: [],
    pendingProcessEventIndex: 0,
    processEventDrainRunning: false,
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date().toISOString(),
    cols: input.cols,
    rows: input.rows,
    process: null,
    unsubscribeData: null,
    unsubscribeExit: null,
    hasRunningSubprocess: false,
    runtimeEnv: input.runtimeEnv,
  };
}
