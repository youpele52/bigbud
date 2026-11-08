import { create } from "zustand";
import { type AppCheckStatus } from "../../lib/checkStatus";
import type { ServerRemoteAgentRuntimeSummary } from "@bigbud/contracts/server/server.ts";
import type { SshAuthMode } from "../../lib/ssh";

interface PendingRemoteAccessAction {
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly onVerified: () => Promise<void> | void;
  readonly unavailableTitle?: string;
  readonly skipAgentVerification?: boolean;
  readonly onCancel?: () => void;
}

export type RemoteExecutionAuthMode = SshAuthMode;

export interface RemoteExecutionCheckState {
  readonly status: AppCheckStatus;
  readonly message: string;
  readonly tip: string | null;
  readonly authMode: RemoteExecutionAuthMode | null;
  readonly promptLabel: string | null;
  readonly updatedAt: string;
}

interface RemoteAccessState {
  remoteConnections: Record<string, ServerRemoteAgentRuntimeSummary>;
  recordRemoteConnection: (target: string, summary: ServerRemoteAgentRuntimeSummary) => void;
  verifiedExecutionTargetIds: Record<string, true>;
  /** User-initiated, server-persisted SSH disconnects keyed by execution target id. */
  disconnectedExecutionTargetIds: Record<string, true>;
  /** False until the first server list load settles; auto-connect paths wait for it. */
  disconnectedTargetsLoaded: boolean;
  /** Bumped by every local Disconnect/Connect so a racing server list load can keep it. */
  disconnectedChangeVersions: Record<string, number>;
  executionTargetChecks: Record<string, RemoteExecutionCheckState>;
  pendingAction: PendingRemoteAccessAction | null;
  isAuthDialogOpen: boolean;
  authMode: RemoteExecutionAuthMode | null;
  authPromptLabel: string;
  authSecret: string;
  authError: string | null;
  isAuthenticating: boolean;
  markExecutionTargetVerified: (executionTargetId: string) => void;
  clearExecutionTargetVerified: (executionTargetId: string) => void;
  markExecutionTargetDisconnected: (executionTargetId: string) => void;
  clearExecutionTargetDisconnected: (executionTargetId: string) => void;
  replaceDisconnectedExecutionTargetIds: (executionTargetIds: readonly string[]) => void;
  markDisconnectedTargetsLoaded: () => void;
  setExecutionTargetCheck: (
    executionTargetId: string,
    check: Omit<RemoteExecutionCheckState, "updatedAt">,
  ) => void;
  openAuthDialog: (input: {
    pendingAction: PendingRemoteAccessAction;
    authMode: RemoteExecutionAuthMode;
    promptLabel: string;
    skipAgentVerification?: boolean;
  }) => boolean;
  closeAuthDialog: () => void;
  clearAuthDialog: () => void;
  setAuthSecret: (secret: string) => void;
  setAuthPrompt: (mode: SshAuthMode, label: string) => void;
  setAuthError: (error: string | null) => void;
  setIsAuthenticating: (authenticating: boolean) => void;
}

function bumpVersion(versions: Record<string, number>, executionTargetId: string) {
  return { ...versions, [executionTargetId]: (versions[executionTargetId] ?? 0) + 1 };
}

export const useRemoteAccessStore = create<RemoteAccessState>()((set) => ({
  remoteConnections: {},
  recordRemoteConnection: (target, summary) =>
    set((state) => ({ remoteConnections: { ...state.remoteConnections, [target]: summary } })),
  verifiedExecutionTargetIds: {},
  disconnectedExecutionTargetIds: {},
  disconnectedTargetsLoaded: false,
  disconnectedChangeVersions: {},
  executionTargetChecks: {},
  pendingAction: null,
  isAuthDialogOpen: false,
  authMode: null,
  authPromptLabel: "",
  authSecret: "",
  authError: null,
  isAuthenticating: false,
  markExecutionTargetVerified: (executionTargetId) =>
    set((state) => ({
      verifiedExecutionTargetIds:
        state.verifiedExecutionTargetIds[executionTargetId] === true
          ? state.verifiedExecutionTargetIds
          : {
              ...state.verifiedExecutionTargetIds,
              [executionTargetId]: true,
            },
      executionTargetChecks: {
        ...state.executionTargetChecks,
        [executionTargetId]: {
          status: "verified",
          message: "Remote access verified.",
          tip: null,
          authMode: null,
          promptLabel: null,
          updatedAt: new Date().toISOString(),
        },
      },
    })),
  clearExecutionTargetVerified: (executionTargetId) =>
    set((state) => {
      if (!(executionTargetId in state.verifiedExecutionTargetIds)) {
        return state;
      }

      const nextVerifiedExecutionTargetIds = { ...state.verifiedExecutionTargetIds };
      delete nextVerifiedExecutionTargetIds[executionTargetId];
      return {
        verifiedExecutionTargetIds: nextVerifiedExecutionTargetIds,
        executionTargetChecks: {
          ...state.executionTargetChecks,
          [executionTargetId]: {
            status: "idle",
            message: "Remote access check has not started yet.",
            tip: null,
            authMode: null,
            promptLabel: null,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    }),
  markExecutionTargetDisconnected: (executionTargetId) =>
    set((state) => ({
      disconnectedChangeVersions: bumpVersion(state.disconnectedChangeVersions, executionTargetId),
      ...(state.disconnectedExecutionTargetIds[executionTargetId] === true
        ? {}
        : {
            disconnectedExecutionTargetIds: {
              ...state.disconnectedExecutionTargetIds,
              [executionTargetId]: true,
            },
          }),
    })),
  clearExecutionTargetDisconnected: (executionTargetId) =>
    set((state) => {
      const disconnectedChangeVersions = bumpVersion(
        state.disconnectedChangeVersions,
        executionTargetId,
      );
      if (!(executionTargetId in state.disconnectedExecutionTargetIds)) {
        return { disconnectedChangeVersions };
      }
      const next = { ...state.disconnectedExecutionTargetIds };
      delete next[executionTargetId];
      return { disconnectedExecutionTargetIds: next, disconnectedChangeVersions };
    }),
  replaceDisconnectedExecutionTargetIds: (executionTargetIds) =>
    set({
      disconnectedExecutionTargetIds: Object.fromEntries(
        executionTargetIds.map((executionTargetId) => [executionTargetId, true as const]),
      ),
      disconnectedTargetsLoaded: true,
    }),
  markDisconnectedTargetsLoaded: () =>
    set((state) => (state.disconnectedTargetsLoaded ? state : { disconnectedTargetsLoaded: true })),
  setExecutionTargetCheck: (executionTargetId, check) =>
    set((state) => {
      const nextVerifiedExecutionTargetIds = { ...state.verifiedExecutionTargetIds };
      if (check.status === "verified") {
        nextVerifiedExecutionTargetIds[executionTargetId] = true;
      } else if (check.status === "auth_required" || check.status === "error") {
        delete nextVerifiedExecutionTargetIds[executionTargetId];
      }
      return {
        verifiedExecutionTargetIds: nextVerifiedExecutionTargetIds,
        executionTargetChecks: {
          ...state.executionTargetChecks,
          [executionTargetId]: {
            ...check,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    }),
  openAuthDialog: ({ pendingAction, authMode, promptLabel }) => {
    const current = useRemoteAccessStore.getState().pendingAction;
    if (current) return false;
    set({
      pendingAction,
      isAuthDialogOpen: true,
      authMode,
      authPromptLabel: promptLabel,
      authSecret: "",
      authError: null,
      isAuthenticating: false,
    });
    return true;
  },
  closeAuthDialog: () => {
    useRemoteAccessStore.getState().pendingAction?.onCancel?.();
    useRemoteAccessStore.getState().clearAuthDialog();
  },
  clearAuthDialog: () =>
    set({
      pendingAction: null,
      isAuthDialogOpen: false,
      authMode: null,
      authPromptLabel: "",
      authSecret: "",
      authError: null,
      isAuthenticating: false,
    }),
  setAuthSecret: (authSecret) => set({ authSecret }),
  setAuthPrompt: (authMode, authPromptLabel) =>
    set({ authMode, authPromptLabel, authSecret: "", authError: null }),
  setAuthError: (authError) => set({ authError }),
  setIsAuthenticating: (isAuthenticating) => set({ isAuthenticating }),
}));

export function isExecutionTargetVerified(executionTargetId: string | null | undefined): boolean {
  if (!executionTargetId) {
    return false;
  }

  return useRemoteAccessStore.getState().verifiedExecutionTargetIds[executionTargetId] === true;
}

export const REMOTE_EXECUTION_TARGET_DISCONNECTED_MESSAGE =
  "Remote workspace is disconnected. Connect it to continue.";

export function isExecutionTargetDisconnected(
  executionTargetId: string | null | undefined,
): boolean {
  if (!executionTargetId) {
    return false;
  }

  return useRemoteAccessStore.getState().disconnectedExecutionTargetIds[executionTargetId] === true;
}

export function useIsExecutionTargetDisconnected(executionTargetId: string): boolean {
  return useRemoteAccessStore(
    (store) => store.disconnectedExecutionTargetIds[executionTargetId] === true,
  );
}

export function areDisconnectedTargetsLoaded(): boolean {
  return useRemoteAccessStore.getState().disconnectedTargetsLoaded;
}

export function useDisconnectedTargetsLoaded(): boolean {
  return useRemoteAccessStore((store) => store.disconnectedTargetsLoaded);
}
