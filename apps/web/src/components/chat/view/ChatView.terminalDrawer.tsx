import { projectScriptCwd, projectScriptRuntimeEnv } from "@bigbud/shared/projectScripts";
import type { ThreadId } from "@bigbud/contracts";
import { useCallback, useMemo, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useProjectById, useThreadById } from "../../../stores/main";
import { useComposerDraftStore } from "../../../stores/composer";
import { selectThreadTerminalState } from "../../../stores/terminal";
import { useTerminalStateStore } from "../../../stores/terminal";
import ThreadTerminalDrawer from "../../terminal/ThreadTerminalDrawer";
import type { TerminalContextSelection } from "../../../lib/terminalContext";
import { readNativeApi } from "../../../rpc/nativeApi";
import { useDefaultChatCwd } from "../../../rpc/serverState";

interface PersistentThreadTerminalDrawerProps {
  threadId: ThreadId;
  visible: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

interface PersistentTerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export function PersistentThreadTerminalDrawer({
  threadId,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const serverThread = useThreadById(threadId);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const project = useProjectById(serverThread?.projectId ?? draftThread?.projectId);
  const defaultChatCwd = useDefaultChatCwd();
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
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

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !terminalState.terminalOpen || !cwd) {
    return null;
  }

  return (
    <div className={visible ? undefined : "hidden"}>
      <ThreadTerminalDrawer
        threadId={threadId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible={visible}
        height={terminalState.terminalHeight}
        terminalIds={terminalState.terminalIds}
        activeTerminalId={terminalState.activeTerminalId}
        terminalGroups={terminalState.terminalGroups}
        activeTerminalGroupId={terminalState.activeTerminalGroupId}
        focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
        onSplitTerminal={splitTerminal}
        onNewTerminal={createNewTerminal}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        onActiveTerminalChange={activateTerminal}
        onCloseTerminal={closeTerminal}
        onHeightChange={setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
      />
    </div>
  );
}
