import { memo, useMemo, useState } from "react";
import { type ExecutionTargetId, LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";
import { KeyRoundIcon } from "lucide-react";
import { type TimelineWorkEntry, workEntryCopyText } from "./MessagesTimeline.workEntry.logic";
import { Button } from "../../ui/button";
import { MessageCopyButton } from "../common/MessageCopyButton";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../../../rpc/nativeApi";
import { getPassphraseProtectedSshKeyPath, getSshAuthFailureToastTitle } from "../../../lib/ssh";
import { SidebarUnlockSshKeyDialog } from "../../sidebar/SidebarUnlockSshKeyDialog";
import { toastManager } from "../../ui/toast";

export const WorkEntryActionButtons = memo(function WorkEntryActionButtons(props: {
  workEntry: TimelineWorkEntry;
  executionTargetId?: ExecutionTargetId | undefined;
  className?: string;
}) {
  const { workEntry, executionTargetId, className } = props;
  const copyText = workEntryCopyText(workEntry);
  const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false);
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");
  const [sshKeyUnlockError, setSshKeyUnlockError] = useState<string | null>(null);
  const [isUnlockingSshKey, setIsUnlockingSshKey] = useState(false);
  const sshKeyPath = useMemo(
    () =>
      executionTargetId && executionTargetId !== LOCAL_EXECUTION_TARGET_ID
        ? getPassphraseProtectedSshKeyPath(workEntry.detail)
        : null,
    [executionTargetId, workEntry.detail],
  );

  const submitSshKeyUnlock = async () => {
    const passphrase = sshKeyPassphrase.trim();
    if (!sshKeyPath || !executionTargetId || executionTargetId === LOCAL_EXECUTION_TARGET_ID) {
      return;
    }
    if (passphrase.length === 0) {
      setSshKeyUnlockError("Enter the SSH key passphrase.");
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setSshKeyUnlockError("Native API not found.");
      return;
    }

    setIsUnlockingSshKey(true);
    setSshKeyUnlockError(null);
    try {
      await api.server.unlockSshKey({
        executionTargetId,
        passphrase,
      });
      setIsUnlockDialogOpen(false);
      setSshKeyPassphrase("");
      toastManager.add({
        type: "success",
        title: "SSH key unlocked",
        description: "Retry the turn now that the remote SSH key is available.",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to unlock the SSH key.";
      setSshKeyUnlockError(errorMessage);
      toastManager.add({
        type: "error",
        title: getSshAuthFailureToastTitle("ssh-key-passphrase"),
        description: errorMessage,
      });
    } finally {
      setIsUnlockingSshKey(false);
    }
  };

  return (
    <>
      <div className={cn("flex min-w-0 items-center gap-2", className)}>
        <MessageCopyButton text={copyText} />
        {sshKeyPath ? (
          <Button
            size="xs"
            variant="text"
            type="button"
            onClick={() => {
              setSshKeyUnlockError(null);
              setIsUnlockDialogOpen(true);
            }}
            title="Unlock SSH key"
          >
            <KeyRoundIcon className="size-3" />
            <span>Unlock SSH key</span>
          </Button>
        ) : null}
      </div>
      {sshKeyPath ? (
        <SidebarUnlockSshKeyDialog
          open={isUnlockDialogOpen}
          keyPath={sshKeyPath}
          description={
            <>
              bigbud needs the passphrase for{" "}
              <span className="break-all font-light">&quot;{sshKeyPath}&quot;</span> before it can
              start provider sessions on this remote target.
            </>
          }
          secret={sshKeyPassphrase}
          error={sshKeyUnlockError}
          isSubmitting={isUnlockingSshKey}
          onOpenChange={(open) => {
            if (!isUnlockingSshKey) {
              setIsUnlockDialogOpen(open);
            }
          }}
          onSecretChange={setSshKeyPassphrase}
          onSubmit={() => {
            void submitSshKeyUnlock();
          }}
        />
      ) : null}
    </>
  );
});
