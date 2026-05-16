import { type ProjectScript, type ThreadId, TerminalOpenInput } from "@bigbud/contracts";
import { useCallback } from "react";
import { projectScriptRuntimeEnv } from "@bigbud/shared/projectScripts";
import { DEFAULT_THREAD_TERMINAL_ID, MAX_TERMINALS_PER_GROUP } from "../../../models/types";
import { randomUUID } from "~/lib/utils";
import { readNativeApi } from "../../../rpc/nativeApi";
import type { Thread, Project } from "../../../models/types";
import { SCRIPT_TERMINAL_COLS, SCRIPT_TERMINAL_ROWS } from "./ChatView.constants.logic";

export interface UseTerminalActionsInput {
  activeThread: Thread | undefined;
  activeThreadId: ThreadId | null;
  activeProject: Project | undefined;
  gitCwd: string | null;
  terminalState: {
    terminalOpen: boolean;
    terminalIds: string[];
    activeTerminalId: string;
    runningTerminalIds: string[];
    terminalGroups: Array<{ id: string; terminalIds: string[] }>;
    activeTerminalGroupId: string;
  };
  storeSetTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  storeSplitTerminal: (threadId: ThreadId, terminalId: string) => void;
  storeNewTerminal: (threadId: ThreadId, terminalId: string) => void;
  storeSetActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  storeCloseTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalFocusRequestId: React.Dispatch<React.SetStateAction<number>>;
  setTerminalLaunchContext: React.Dispatch<
    React.SetStateAction<{ threadId: ThreadId; cwd: string; worktreePath: string | null } | null>
  >;
  setLastInvokedScriptByProjectId: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
}

export interface UseTerminalActionsResult {
  setTerminalOpen: (open: boolean) => void;
  toggleTerminalVisibility: () => void;
  splitTerminal: () => void;
  createNewTerminal: () => void;
  closeTerminal: (terminalId: string) => void;
  runTerminalCommand: (
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      worktreePath?: string | null;
      preferNewTerminal?: boolean;
    },
  ) => Promise<void>;
  runProjectScript: (
    script: ProjectScript,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      worktreePath?: string | null;
      preferNewTerminal?: boolean;
      rememberAsLastInvoked?: boolean;
    },
  ) => Promise<void>;
  hasReachedSplitLimit: boolean;
}

export function useTerminalActions(input: UseTerminalActionsInput): UseTerminalActionsResult {
  const {
    activeThread,
    activeThreadId,
    activeProject,
    gitCwd,
    terminalState,
    storeSetTerminalOpen,
    storeSplitTerminal,
    storeNewTerminal,
    storeSetActiveTerminal,
    storeCloseTerminal,
    setTerminalFocusRequestId,
    setTerminalLaunchContext,
    setLastInvokedScriptByProjectId,
    setThreadError,
  } = input;

  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;

  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );

  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, terminalState.terminalOpen]);

  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminal, setTerminalFocusRequestId]);

  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal, setTerminalFocusRequestId]);

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      storeCloseTerminal,
      terminalState.terminalIds.length,
      setTerminalFocusRequestId,
    ],
  );

  const runTerminalCommand = useCallback(
    async (
      command: string,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        setThreadError(activeThreadId, "Enter a terminal command after !.");
        return;
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      if (!targetCwd) {
        setThreadError(activeThreadId, "This chat does not have a runnable workspace path.");
        return;
      }
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const targetTerminalId = wantsNewTerminal ? `terminal-${randomUUID()}` : baseTerminalId;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (wantsNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = wantsNewTerminal
        ? {
            threadId: activeThreadId,
            ...(activeProject.executionTargetId
              ? { executionTargetId: activeProject.executionTargetId }
              : {}),
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            ...(activeProject.executionTargetId
              ? { executionTargetId: activeProject.executionTargetId }
              : {}),
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${trimmedCommand}\r`,
        });
        setThreadError(activeThreadId, null);
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run command "${trimmedCommand}".`,
        );
        throw error;
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
      setTerminalFocusRequestId,
      setTerminalLaunchContext,
    ],
  );

  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!activeProject) {
        return;
      }
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      await runTerminalCommand(script.command, options).catch(() => undefined);
    },
    [activeProject, setLastInvokedScriptByProjectId, runTerminalCommand],
  );

  return {
    setTerminalOpen,
    toggleTerminalVisibility,
    splitTerminal,
    createNewTerminal,
    closeTerminal,
    runTerminalCommand,
    runProjectScript,
    hasReachedSplitLimit,
  };
}
