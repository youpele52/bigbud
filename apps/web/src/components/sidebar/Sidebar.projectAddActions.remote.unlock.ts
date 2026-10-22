import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { toastManager } from "../ui/toast";
import { readNativeApi } from "../../rpc/nativeApi";
import {
  getPassphraseProtectedSshKeyPath,
  getPasswordProtectedSshTargetLabel,
  getSshAuthFailureToastTitle,
} from "../../lib/ssh";
import {
  createRemoteProjectExecutionTargetId,
  type RemoteProjectDraft,
} from "./Sidebar.projects.logic";

export type RemoteProjectUnlockMode = "ssh-key-passphrase" | "password";

/**
 * SSH key-passphrase / password prompt for the remote project dialog. A request may carry a
 * continuation (e.g. retry folder browsing) that runs after unlocking instead of the default.
 */
export function useRemoteProjectUnlock({
  draft,
  setDialogError,
}: {
  draft: RemoteProjectDraft;
  setDialogError: Dispatch<SetStateAction<string | null>>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<RemoteProjectUnlockMode | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const continuationRef = useRef<(() => void) | null>(null);

  /** Hides the prompt and forgets any pending continuation. */
  const dismiss = useCallback(() => {
    continuationRef.current = null;
    setIsOpen(false);
    setMode(null);
    setKeyPath("");
    setPassphrase("");
    setError(null);
  }, []);

  const reset = useCallback(() => {
    dismiss();
    setIsUnlocking(false);
  }, [dismiss]);

  /** Opens the prompt when `errorMessage` is an SSH lock error; returns whether it did. */
  const request = useCallback(
    (errorMessage: string, continuation?: () => void) => {
      const lockedKeyPath = getPassphraseProtectedSshKeyPath(errorMessage);
      const label = lockedKeyPath ?? getPasswordProtectedSshTargetLabel(errorMessage);
      if (!label) return false;
      continuationRef.current = continuation ?? null;
      setDialogError(null);
      setMode(lockedKeyPath ? "ssh-key-passphrase" : "password");
      setKeyPath(label);
      setPassphrase("");
      setError(null);
      setIsOpen(true);
      return true;
    },
    [setDialogError],
  );

  const close = useCallback(() => {
    if (!isUnlocking) dismiss();
  }, [dismiss, isUnlocking]);

  /** Unlocks, then runs the request's continuation or `afterUnlock` (verify and save). */
  const submit = useCallback(
    async (afterUnlock: () => Promise<void>) => {
      const secret = passphrase.trim();
      if (secret.length === 0) {
        setError(mode === "password" ? "Enter the SSH password." : "Enter the SSH key passphrase.");
        return;
      }

      const api = readNativeApi();
      if (!api) {
        setError("Native API not found.");
        return;
      }

      setIsUnlocking(true);
      setError(null);
      try {
        const executionTargetId = createRemoteProjectExecutionTargetId(draft);
        if (mode === "password") {
          await api.server.unlockSshPassword({ executionTargetId, password: secret });
        } else {
          await api.server.unlockSshKey({ executionTargetId, passphrase: secret });
        }
        const continuation = continuationRef.current;
        setIsOpen(false);
        setMode(null);
        setPassphrase("");
        setKeyPath("");
        continuationRef.current = null;

        if (continuation) {
          continuation();
          return;
        }
        await afterUnlock();
      } catch (unlockError) {
        const errorMessage =
          unlockError instanceof Error
            ? unlockError.message
            : mode === "password"
              ? "Failed to unlock the SSH password session."
              : "Failed to unlock the SSH key.";
        setError(errorMessage);
        if (mode) {
          toastManager.add({
            type: "error",
            title: getSshAuthFailureToastTitle(mode),
            description: errorMessage,
          });
        }
      } finally {
        setIsUnlocking(false);
      }
    },
    [draft, mode, passphrase],
  );

  return {
    isOpen,
    mode,
    keyPath,
    passphrase,
    setPassphrase,
    error,
    isUnlocking,
    request,
    close,
    dismiss,
    reset,
    submit,
  };
}
