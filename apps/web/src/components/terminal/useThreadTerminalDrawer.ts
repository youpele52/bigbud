import { type ThreadId } from "@bigbud/contracts";
import { useCallback, useMemo, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@bigbud/shared/projectScripts";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useProjectById, useThreadById } from "../../stores/main";
import { useComposerDraftStore } from "../../stores/composer";
import { selectThreadTerminalState, useTerminalStateStore } from "../../stores/terminal";
import { useDefaultChatCwd } from "../../rpc/serverState";
import { readNativeApi } from "../../rpc/nativeApi";

export interface TerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export interface UseThreadTerminalDrawerResult {
  project: ReturnType<typeof useProjectById>;
  terminalState: ReturnType<typeof selectThreadTerminalState>;
  cwd: string | null;
  effectiveWorktreePath: string | null;
  runtimeEnv: Record<string, string>;
  executionTargetId: string | undefined;
  splitTerminal: () => void;
  createNewTerminal: () => void;
  activateTerminal: (terminalId: string) => void;
  closeTerminal: (terminalId: string) => void;
  setTerminalHeight: (height: number) => void;
  focusRequestId: number;
  bumpFocusRequestId: () => void;
}

export function useThreadTerminalDrawer(
  threadId: ThreadId,
  launchContext: TerminalLaunchContext | null,
  visible: boolean,
  mode: "drawer" | "panel" = "drawer",
): UseThreadTerminalDrawerResult {
  const serverThread = useThreadById(threadId);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const project = useProjectById(serverThread?.projectId ?? draftThread?.projectId);
  const defaultChatCwd = useDefaultChatCwd();

  const isPanel = mode === "panel";
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(
      isPanel ? state.panelTerminalStateByThreadId : state.terminalStateByThreadId,
      threadId,
    ),
  );
  const storeSetTerminalHeight = useTerminalStateStore((state) =>
    isPanel ? state.setPanelTerminalHeight : state.setTerminalHeight,
  );
  const storeSplitTerminal = useTerminalStateStore((state) =>
    isPanel ? state.splitPanelTerminal : state.splitTerminal,
  );
  const storeNewTerminal = useTerminalStateStore((state) =>
    isPanel ? state.newPanelTerminal : state.newTerminal,
  );
  const storeSetActiveTerminal = useTerminalStateStore((state) =>
    isPanel ? state.setPanelActiveTerminal : state.setActiveTerminal,
  );
  const storeCloseTerminal = useTerminalStateStore((state) =>
    isPanel ? state.closePanelTerminal : state.closeTerminal,
  );

  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : null) ??
      defaultChatCwd,
    [defaultChatCwd, effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadId, height);
    },
    [storeSetTerminalHeight, threadId],
  );

  const splitTerminal = useCallback(() => {
    storeSplitTerminal(threadId, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeSplitTerminal, threadId]);

  const createNewTerminal = useCallback(() => {
    storeNewTerminal(threadId, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeNewTerminal, threadId]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadId, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadId],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
          }
          await api.terminal.close({
            threadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      storeCloseTerminal(threadId, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeCloseTerminal, terminalState.terminalIds.length, threadId],
  );

  return {
    project,
    terminalState,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    executionTargetId: project ? resolveWorkspaceExecutionTargetId(project) : undefined,
    splitTerminal,
    createNewTerminal,
    activateTerminal,
    closeTerminal,
    setTerminalHeight,
    focusRequestId: localFocusRequestId,
    bumpFocusRequestId,
  };
}
