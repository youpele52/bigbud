import type { TerminalSplitDirection } from "../../lib/terminalSplitLayout";
import { LOCAL_EXECUTION_TARGET_ID, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@bigbud/shared/projectScripts";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useProjectById, useThreadById } from "../../stores/main";
import { useComposerDraftStore } from "../../stores/composer";
import { selectThreadTerminalState, useTerminalStateStore } from "../../stores/terminal";
import { resolveTerminalAgentKind } from "./terminalAgentKind.resolve";
import { useServerSettings } from "../../rpc/serverState";
import { readNativeApi } from "../../rpc/nativeApi";
import { resolveTerminalBaseLabel } from "./terminalDisplay";
import { closeTerminalConfirmed } from "./terminalLifecycle.operations";
import { requestTerminalClose, type CloseTerminalHandler } from "./terminalCloseGuard";
import { resolveManualTerminalTarget } from "../../stores/terminal/terminal.store.wsl";
import type { TerminalAgentKind } from "../../stores/terminal/terminal.store.agentKind";
import { canCreateProfileTerminal } from "./TerminalProfilePicker.launch";
import { inheritsNothing } from "../../stores/terminal/terminal.store.create";

const EMPTY_TERMINAL_LABEL_OVERRIDES: Record<string, string> = Object.freeze({});
const EMPTY_TERMINAL_EVENT_ENTRIES_BY_KEY = Object.freeze({});

export interface TerminalLaunchContext {
  cwd: string;
  worktreePath: string | null;
}

export interface UseThreadTerminalDrawerResult {
  projectId: ProjectId | undefined;
  project: ReturnType<typeof useProjectById>;
  terminalState: ReturnType<typeof selectThreadTerminalState>;
  cwd: string | null;
  effectiveWorktreePath: string | null;
  runtimeEnv: Record<string, string>;
  executionTargetId: string | undefined;
  terminalBaseLabel: string;
  terminalLabelOverrides: Record<string, string>;
  terminalProviderById: Readonly<Record<string, TerminalAgentKind>>;
  splitTerminal: (direction?: TerminalSplitDirection) => void;
  createNewTerminal: (
    profile?: import("../../lib/terminalProfileLaunch").TerminalProfileLaunch,
  ) => void;
  activateTerminal: (terminalId: string) => void;
  closeTerminal: CloseTerminalHandler;
  setTerminalLabelOverride: (terminalId: string, label: string) => void;
  clearTerminalLabelOverride: (terminalId: string) => void;
  setTerminalHeight: (height: number) => void;
  focusRequestId: number;
  bumpFocusRequestId: () => void;
}

export function resolveTerminalExecutionTargetId(input: {
  readonly serverThread: Parameters<typeof resolveWorkspaceExecutionTargetId>[0] | null | undefined;
  readonly project: Parameters<typeof resolveWorkspaceExecutionTargetId>[0] | null | undefined;
}): string | undefined {
  return input.serverThread
    ? resolveWorkspaceExecutionTargetId(input.serverThread)
    : input.project
      ? resolveWorkspaceExecutionTargetId(input.project)
      : undefined;
}

/**
 * Bounded catalog replacement can evict a hidden thread's project. Mounted terminals keep their
 * last-known project so cwd, env and labels do not rebind or unmount while it is re-fetched.
 */
function useLastKnownProject(
  projectId: ProjectId | undefined,
  liveProject: ReturnType<typeof useProjectById>,
): ReturnType<typeof useProjectById> {
  // A ref, not state: selectors may return fresh objects, and recording one must not re-render.
  const lastKnownProject = useRef(liveProject);
  useEffect(() => {
    if (liveProject) lastKnownProject.current = liveProject;
  }, [liveProject]);
  if (liveProject) return liveProject;
  const fallback = lastKnownProject.current;
  return fallback?.id === projectId ? fallback : undefined;
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
  const projectId = serverThread?.projectId ?? draftThread?.projectId;
  const project = useLastKnownProject(projectId, useProjectById(projectId));
  // Leave home expansion to the launch target, not to the server's welcome payload.
  const defaultChatCwd = useServerSettings().defaultChatCwd;
  const distribution = useTerminalStateStore(
    (state) => state.terminalWslDistributionByThreadId[threadId],
  );
  const executionTargetId = resolveManualTerminalTarget(
    resolveTerminalExecutionTargetId({ serverThread, project }),
    distribution,
  );
  const useLegacyOutputDetection =
    executionTargetId !== undefined && executionTargetId !== LOCAL_EXECUTION_TARGET_ID;

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
  const terminalLabelOverrides = useTerminalStateStore(
    (state) => state.terminalLabelOverridesByThreadId[threadId] ?? EMPTY_TERMINAL_LABEL_OVERRIDES,
  );
  const terminalEventEntriesByKey = useTerminalStateStore((state) =>
    useLegacyOutputDetection
      ? state.terminalEventEntriesByKey
      : EMPTY_TERMINAL_EVENT_ENTRIES_BY_KEY,
  );
  const terminalAgentProviderByKey = useTerminalStateStore(
    (state) => state.terminalAgentProviderByKey,
  );
  const storeSetTerminalLabelOverride = useTerminalStateStore(
    (state) => state.setTerminalLabelOverride,
  );
  const storeClearTerminalLabelOverride = useTerminalStateStore(
    (state) => state.clearTerminalLabelOverride,
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
  const terminalBaseLabel = useMemo(
    () =>
      resolveTerminalBaseLabel({
        projectName: project?.name,
        cwd,
      }),
    [cwd, project?.name],
  );
  const terminalProviderById = useMemo(() => {
    const nextById: Record<string, TerminalAgentKind> = {};
    const source = { terminalAgentProviderByKey, terminalEventEntriesByKey };
    for (const terminalId of terminalState.terminalIds) {
      const provider = resolveTerminalAgentKind(source, threadId, terminalId);
      if (provider) nextById[terminalId] = provider;
    }
    return nextById;
  }, [terminalAgentProviderByKey, terminalEventEntriesByKey, terminalState.terminalIds, threadId]);

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

  // A first pane has no source pane to inherit from: it starts this thread's default target.
  const isEmptySurface = terminalState.terminalIds.length === 0;
  const splitTerminal = useCallback(
    (direction: TerminalSplitDirection = "right") => {
      const profile = { newExecutionTargetId: executionTargetId ?? LOCAL_EXECUTION_TARGET_ID };
      if (
        !isEmptySurface &&
        !canCreateProfileTerminal(threadId, terminalState.activeTerminalId, profile)
      )
        return;
      storeSplitTerminal(threadId, `terminal-${randomUUID()}`, profile, direction);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      isEmptySurface,
      storeSplitTerminal,
      threadId,
      terminalState.activeTerminalId,
      executionTargetId,
    ],
  );

  const createNewTerminal = useCallback(
    (profile?: import("../../lib/terminalProfileLaunch").TerminalProfileLaunch) => {
      const requested = profile ?? {
        newExecutionTargetId: executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
      };
      // A target-only request needs no source pane; an explicit shell profile still does.
      if (
        !(isEmptySurface && inheritsNothing(requested)) &&
        !canCreateProfileTerminal(threadId, terminalState.activeTerminalId, requested)
      )
        return;
      storeNewTerminal(threadId, `terminal-${randomUUID()}`, requested);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      isEmptySurface,
      storeNewTerminal,
      threadId,
      terminalState.activeTerminalId,
      executionTargetId,
    ],
  );

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadId, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadId],
  );

  const closeTerminal = useCallback<CloseTerminalHandler>(
    (terminalId, options) => {
      const api = readNativeApi();
      if (!api) return;
      requestTerminalClose({
        threadId,
        terminalId,
        options,
        close: () =>
          void closeTerminalConfirmed({
            api,
            threadId,
            terminalId,
            executionTargetId,
            onPending: () => {
              // Read now: the confirmation may have waited while panes changed.
              const surfaces = useTerminalStateStore.getState();
              const current = (
                isPanel ? surfaces.panelTerminalStateByThreadId : surfaces.terminalStateByThreadId
              )[threadId];
              const next = current?.terminalIds.find((id) => id !== terminalId);
              if (next && current?.activeTerminalId === terminalId)
                storeSetActiveTerminal(threadId, next);
              bumpFocusRequestId();
            },
            onConfirmed: () => storeCloseTerminal(threadId, terminalId),
          }),
      });
    },
    [
      bumpFocusRequestId,
      executionTargetId,
      isPanel,
      storeCloseTerminal,
      storeSetActiveTerminal,
      threadId,
    ],
  );

  const setTerminalLabelOverride = useCallback(
    (terminalId: string, label: string) => {
      storeSetTerminalLabelOverride(threadId, terminalId, label);
    },
    [storeSetTerminalLabelOverride, threadId],
  );

  const clearTerminalLabelOverride = useCallback(
    (terminalId: string) => {
      storeClearTerminalLabelOverride(threadId, terminalId);
    },
    [storeClearTerminalLabelOverride, threadId],
  );

  return {
    projectId,
    project,
    terminalState,
    cwd,
    effectiveWorktreePath,
    runtimeEnv,
    executionTargetId,
    terminalBaseLabel,
    terminalLabelOverrides,
    terminalProviderById,
    splitTerminal,
    createNewTerminal,
    activateTerminal,
    closeTerminal,
    setTerminalLabelOverride,
    clearTerminalLabelOverride,
    setTerminalHeight,
    focusRequestId: localFocusRequestId,
    bumpFocusRequestId,
  };
}
