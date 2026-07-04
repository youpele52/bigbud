import { create } from "zustand";
import { type AppCheckStatus } from "../../lib/checkStatus";

interface PendingRemoteAccessAction {
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly onVerified: () => Promise<void> | void;
  readonly unavailableTitle?: string;
}

export type RemoteExecutionAuthMode = "ssh-key-passphrase" | "password";

export interface RemoteExecutionCheckState {
  readonly status: AppCheckStatus;
  readonly message: string;
  readonly tip: string | null;
  readonly authMode: RemoteExecutionAuthMode | null;
  readonly promptLabel: string | null;
  readonly updatedAt: string;
}

interface RemoteAccessState {
  verifiedExecutionTargetIds: Record<string, true>;
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
  setExecutionTargetCheck: (
    executionTargetId: string,
    check: Omit<RemoteExecutionCheckState, "updatedAt">,
  ) => void;
  openAuthDialog: (input: {
    pendingAction: PendingRemoteAccessAction;
    authMode: RemoteExecutionAuthMode;
    promptLabel: string;
  }) => void;
  closeAuthDialog: () => void;
  setAuthSecret: (secret: string) => void;
  setAuthError: (error: string | null) => void;
  setIsAuthenticating: (authenticating: boolean) => void;
}

export const useRemoteAccessStore = create<RemoteAccessState>()((set) => ({
  verifiedExecutionTargetIds: {},
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
  openAuthDialog: ({ pendingAction, authMode, promptLabel }) =>
    set({
      pendingAction,
      isAuthDialogOpen: true,
      authMode,
      authPromptLabel: promptLabel,
      authSecret: "",
      authError: null,
      isAuthenticating: false,
    }),
  closeAuthDialog: () =>
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
  setAuthError: (authError) => set({ authError }),
  setIsAuthenticating: (isAuthenticating) => set({ isAuthenticating }),
}));

export function isExecutionTargetVerified(executionTargetId: string | null | undefined): boolean {
  if (!executionTargetId) {
    return false;
  }

  return useRemoteAccessStore.getState().verifiedExecutionTargetIds[executionTargetId] === true;
}
