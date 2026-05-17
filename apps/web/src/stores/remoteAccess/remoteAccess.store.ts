import { create } from "zustand";

interface PendingRemoteAccessAction {
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly onVerified: () => Promise<void> | void;
  readonly unavailableTitle?: string;
}

export type RemoteExecutionAuthMode = "ssh-key-passphrase" | "password";

interface RemoteAccessState {
  verifiedExecutionTargetIds: Record<string, true>;
  pendingAction: PendingRemoteAccessAction | null;
  isAuthDialogOpen: boolean;
  authMode: RemoteExecutionAuthMode | null;
  authPromptLabel: string;
  authSecret: string;
  authError: string | null;
  isAuthenticating: boolean;
  markExecutionTargetVerified: (executionTargetId: string) => void;
  clearExecutionTargetVerified: (executionTargetId: string) => void;
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
    })),
  clearExecutionTargetVerified: (executionTargetId) =>
    set((state) => {
      if (!(executionTargetId in state.verifiedExecutionTargetIds)) {
        return state;
      }

      const nextVerifiedExecutionTargetIds = { ...state.verifiedExecutionTargetIds };
      delete nextVerifiedExecutionTargetIds[executionTargetId];
      return { verifiedExecutionTargetIds: nextVerifiedExecutionTargetIds };
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
