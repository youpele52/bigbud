import { useCallback, useState } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import {
  getPassphraseProtectedSshKeyPath,
  getPasswordProtectedSshTargetLabel,
} from "../../lib/ssh";
import {
  createDefaultRemoteProjectDraft,
  createRemoteProjectExecutionTargetId,
  createRemoteProjectVerificationKey,
  deriveProjectTitleFromCwd,
  getRemoteProjectConnectionLabel,
  type RemoteProjectDraft,
} from "./Sidebar.projects.logic";
import {
  createRemoteProjectFieldErrors,
  hasRemoteProjectFieldErrors,
  type CreateProjectInput,
  type CreateProjectResult,
  type RemoteProjectField,
  type RemoteProjectFieldErrors,
} from "./Sidebar.projectAddActions.helpers";

interface UseSidebarRemoteProjectAddActionsInput {
  readonly createProject: (input: CreateProjectInput) => Promise<CreateProjectResult>;
  readonly isAddingProject: boolean;
}

export interface SidebarRemoteProjectAddActionsOutput {
  readonly isRemoteProjectDialogOpen: boolean;
  readonly remoteProjectDraft: RemoteProjectDraft;
  readonly remoteProjectFieldErrors: RemoteProjectFieldErrors;
  readonly remoteProjectError: string | null;
  readonly remoteProjectVerificationMessage: string | null;
  readonly isVerifyingRemoteProject: boolean;
  readonly openRemoteProjectDialog: () => void;
  readonly closeRemoteProjectDialog: () => void;
  readonly updateRemoteProjectDraft: <
    K extends RemoteProjectField | "authMode" | "providerRuntimeLocation",
  >(
    field: K,
    value: K extends "authMode"
      ? RemoteProjectDraft["authMode"]
      : K extends "providerRuntimeLocation"
        ? RemoteProjectDraft["providerRuntimeLocation"]
        : string,
  ) => void;
  readonly submitRemoteProjectDialog: () => Promise<void>;
  readonly isRemoteProjectUnlockDialogOpen: boolean;
  readonly remoteProjectUnlockMode: "ssh-key-passphrase" | "password" | null;
  readonly remoteProjectUnlockKeyPath: string;
  readonly remoteProjectUnlockPassphrase: string;
  readonly remoteProjectUnlockError: string | null;
  readonly isUnlockingRemoteProjectKey: boolean;
  readonly closeRemoteProjectUnlockDialog: () => void;
  readonly setRemoteProjectUnlockPassphrase: (passphrase: string) => void;
  readonly submitRemoteProjectUnlock: () => Promise<void>;
}

export function useSidebarRemoteProjectAddActions({
  createProject,
  isAddingProject,
}: UseSidebarRemoteProjectAddActionsInput): SidebarRemoteProjectAddActionsOutput {
  const [isRemoteProjectDialogOpen, setIsRemoteProjectDialogOpen] = useState(false);
  const [remoteProjectDraft, setRemoteProjectDraft] = useState<RemoteProjectDraft>(
    createDefaultRemoteProjectDraft,
  );
  const [remoteProjectFieldErrors, setRemoteProjectFieldErrors] =
    useState<RemoteProjectFieldErrors>({});
  const [remoteProjectError, setRemoteProjectError] = useState<string | null>(null);
  const [remoteProjectVerificationMessage, setRemoteProjectVerificationMessage] = useState<
    string | null
  >(null);
  const [remoteProjectVerifiedKey, setRemoteProjectVerifiedKey] = useState<string | null>(null);
  const [isVerifyingRemoteProject, setIsVerifyingRemoteProject] = useState(false);
  const [isRemoteProjectUnlockDialogOpen, setIsRemoteProjectUnlockDialogOpen] = useState(false);
  const [remoteProjectUnlockMode, setRemoteProjectUnlockMode] = useState<
    "ssh-key-passphrase" | "password" | null
  >(null);
  const [remoteProjectUnlockKeyPath, setRemoteProjectUnlockKeyPath] = useState("");
  const [remoteProjectUnlockPassphrase, setRemoteProjectUnlockPassphrase] = useState("");
  const [remoteProjectUnlockError, setRemoteProjectUnlockError] = useState<string | null>(null);
  const [isUnlockingRemoteProjectKey, setIsUnlockingRemoteProjectKey] = useState(false);

  const resetRemoteProjectDialog = useCallback(() => {
    setIsRemoteProjectDialogOpen(false);
    setRemoteProjectDraft(createDefaultRemoteProjectDraft());
    setRemoteProjectFieldErrors({});
    setRemoteProjectError(null);
    setRemoteProjectVerificationMessage(null);
    setRemoteProjectVerifiedKey(null);
    setIsVerifyingRemoteProject(false);
    setIsRemoteProjectUnlockDialogOpen(false);
    setRemoteProjectUnlockMode(null);
    setRemoteProjectUnlockKeyPath("");
    setRemoteProjectUnlockPassphrase("");
    setRemoteProjectUnlockError(null);
    setIsUnlockingRemoteProjectKey(false);
  }, []);

  const openRemoteProjectDialog = useCallback(() => {
    setIsRemoteProjectDialogOpen(true);
    setRemoteProjectFieldErrors({});
    setRemoteProjectError(null);
  }, []);

  const closeRemoteProjectDialog = useCallback(() => {
    if (isAddingProject || isUnlockingRemoteProjectKey) {
      return;
    }
    resetRemoteProjectDialog();
  }, [isAddingProject, isUnlockingRemoteProjectKey, resetRemoteProjectDialog]);

  const updateRemoteProjectDraft = useCallback(
    <K extends RemoteProjectField | "authMode" | "providerRuntimeLocation">(
      field: K,
      value: K extends "authMode"
        ? RemoteProjectDraft["authMode"]
        : K extends "providerRuntimeLocation"
          ? RemoteProjectDraft["providerRuntimeLocation"]
          : string,
    ) => {
      setRemoteProjectDraft((current) => ({ ...current, [field]: value }));
      setRemoteProjectError(null);
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      setIsRemoteProjectUnlockDialogOpen(false);
      setRemoteProjectUnlockMode(null);
      setRemoteProjectUnlockKeyPath("");
      setRemoteProjectUnlockPassphrase("");
      setRemoteProjectUnlockError(null);
      setRemoteProjectFieldErrors((current) => {
        if (!(field in current)) {
          return current;
        }
        const next = { ...current };
        delete next[field as RemoteProjectField];
        return next;
      });
    },
    [],
  );

  const verifyRemoteProjectDialog = useCallback(async () => {
    const nextErrors = createRemoteProjectFieldErrors(remoteProjectDraft);
    setRemoteProjectFieldErrors(nextErrors);

    if (hasRemoteProjectFieldErrors(nextErrors)) {
      setRemoteProjectError("Fix the highlighted fields before verifying the connection.");
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      return "invalid" as const;
    }

    const api = readNativeApi();
    if (!api) {
      setRemoteProjectError("Native API not found.");
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      return "invalid" as const;
    }

    setIsVerifyingRemoteProject(true);
    setRemoteProjectError(null);
    try {
      const result = await api.server.verifyExecutionTarget({
        executionTargetId: createRemoteProjectExecutionTargetId(remoteProjectDraft),
        cwd: remoteProjectDraft.workspaceRoot.trim(),
      });
      setRemoteProjectVerificationMessage(result.message);
      setRemoteProjectVerifiedKey(createRemoteProjectVerificationKey(remoteProjectDraft));
      return "verified" as const;
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to verify the SSH connection for this remote project.";
      const lockedKeyPath = getPassphraseProtectedSshKeyPath(errorMessage);
      const passwordTargetLabel = getPasswordProtectedSshTargetLabel(errorMessage);
      setRemoteProjectVerificationMessage(null);
      setRemoteProjectVerifiedKey(null);
      if (lockedKeyPath) {
        setRemoteProjectError(null);
        setRemoteProjectUnlockMode("ssh-key-passphrase");
        setRemoteProjectUnlockKeyPath(lockedKeyPath);
        setRemoteProjectUnlockPassphrase("");
        setRemoteProjectUnlockError(null);
        setIsRemoteProjectUnlockDialogOpen(true);
        return "unlock-required" as const;
      }
      if (passwordTargetLabel) {
        setRemoteProjectError(null);
        setRemoteProjectUnlockMode("password");
        setRemoteProjectUnlockKeyPath(passwordTargetLabel);
        setRemoteProjectUnlockPassphrase("");
        setRemoteProjectUnlockError(null);
        setIsRemoteProjectUnlockDialogOpen(true);
        return "unlock-required" as const;
      }
      setRemoteProjectError(errorMessage);
      return "invalid" as const;
    } finally {
      setIsVerifyingRemoteProject(false);
    }
  }, [remoteProjectDraft]);

  const submitRemoteProject = useCallback(async () => {
    const remoteTargetLabel = getRemoteProjectConnectionLabel(remoteProjectDraft);
    const title =
      remoteProjectDraft.displayName.trim().length > 0
        ? remoteProjectDraft.displayName.trim()
        : `${deriveProjectTitleFromCwd(remoteProjectDraft.workspaceRoot)} (${remoteTargetLabel})`;

    const result = await createProject({
      rawCwd: remoteProjectDraft.workspaceRoot,
      providerRuntimeLocation: remoteProjectDraft.providerRuntimeLocation,
      workspaceExecutionTargetId: createRemoteProjectExecutionTargetId(remoteProjectDraft),
      title,
    });

    if (!result.ok) {
      setRemoteProjectError(result.error);
      return;
    }

    resetRemoteProjectDialog();
  }, [createProject, remoteProjectDraft, resetRemoteProjectDialog]);

  const submitRemoteProjectDialog = useCallback(async () => {
    setRemoteProjectError(null);
    if (remoteProjectVerifiedKey !== createRemoteProjectVerificationKey(remoteProjectDraft)) {
      const verificationState = await verifyRemoteProjectDialog();
      if (verificationState !== "verified") {
        return;
      }
    }

    await submitRemoteProject();
  }, [
    remoteProjectDraft,
    remoteProjectVerifiedKey,
    submitRemoteProject,
    verifyRemoteProjectDialog,
  ]);

  const closeRemoteProjectUnlockDialog = useCallback(() => {
    if (isUnlockingRemoteProjectKey) {
      return;
    }
    setIsRemoteProjectUnlockDialogOpen(false);
    setRemoteProjectUnlockMode(null);
    setRemoteProjectUnlockKeyPath("");
    setRemoteProjectUnlockPassphrase("");
    setRemoteProjectUnlockError(null);
  }, [isUnlockingRemoteProjectKey]);

  const submitRemoteProjectUnlock = useCallback(async () => {
    const secret = remoteProjectUnlockPassphrase.trim();
    if (secret.length === 0) {
      setRemoteProjectUnlockError(
        remoteProjectUnlockMode === "password"
          ? "Enter the SSH password."
          : "Enter the SSH key passphrase.",
      );
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setRemoteProjectUnlockError("Native API not found.");
      return;
    }

    setIsUnlockingRemoteProjectKey(true);
    setRemoteProjectUnlockError(null);
    try {
      const executionTargetId = createRemoteProjectExecutionTargetId(remoteProjectDraft);
      if (remoteProjectUnlockMode === "password") {
        await api.server.unlockSshPassword({
          executionTargetId,
          password: secret,
        });
      } else {
        await api.server.unlockSshKey({
          executionTargetId,
          passphrase: secret,
        });
      }
      setIsRemoteProjectUnlockDialogOpen(false);
      setRemoteProjectUnlockMode(null);
      setRemoteProjectUnlockPassphrase("");
      setRemoteProjectUnlockKeyPath("");

      const verificationState = await verifyRemoteProjectDialog();
      if (verificationState !== "verified") {
        return;
      }

      await submitRemoteProject();
    } catch (error) {
      setRemoteProjectUnlockError(
        error instanceof Error
          ? error.message
          : remoteProjectUnlockMode === "password"
            ? "Failed to unlock the SSH password session."
            : "Failed to unlock the SSH key.",
      );
    } finally {
      setIsUnlockingRemoteProjectKey(false);
    }
  }, [
    remoteProjectDraft,
    remoteProjectUnlockMode,
    remoteProjectUnlockPassphrase,
    submitRemoteProject,
    verifyRemoteProjectDialog,
  ]);

  return {
    isRemoteProjectDialogOpen,
    remoteProjectDraft,
    remoteProjectFieldErrors,
    remoteProjectError,
    remoteProjectVerificationMessage,
    isVerifyingRemoteProject,
    openRemoteProjectDialog,
    closeRemoteProjectDialog,
    updateRemoteProjectDraft,
    submitRemoteProjectDialog,
    isRemoteProjectUnlockDialogOpen,
    remoteProjectUnlockMode,
    remoteProjectUnlockKeyPath,
    remoteProjectUnlockPassphrase,
    remoteProjectUnlockError,
    isUnlockingRemoteProjectKey,
    closeRemoteProjectUnlockDialog,
    setRemoteProjectUnlockPassphrase,
    submitRemoteProjectUnlock,
  };
}
