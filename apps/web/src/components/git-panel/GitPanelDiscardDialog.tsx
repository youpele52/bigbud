import { isRemoteExecutionTargetId } from "@bigbud/contracts";
import type { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import {
  createGitMutationOperationId,
  gitDiscardChangesMutationOptions,
} from "~/lib/gitReactQuery.mutations";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { toastManager } from "../ui/toast";
import { describeGitDiscardConfirmation, type GitDiscardRequest } from "./GitPanel.discard.logic";

interface GitPanelDiscardDialogProps {
  request: GitDiscardRequest | null;
  workspaceRoot: string;
  executionTargetId?: ExecutionTargetId | undefined;
  onClose: () => void;
}

/** Confirms a discard; nothing is sent to the server until the user confirms. */
export function GitPanelDiscardDialog({
  request,
  workspaceRoot,
  executionTargetId,
  onClose,
}: GitPanelDiscardDialogProps) {
  const queryClient = useQueryClient();
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const mutation = useMutation(
    gitDiscardChangesMutationOptions({ cwd: workspaceRoot, executionTargetId, queryClient }),
  );
  const busy = mutation.isPending;
  const copy = request
    ? describeGitDiscardConfirmation(request, {
        isRemote: !!executionTargetId && isRemoteExecutionTargetId(executionTargetId),
      })
    : null;

  const confirm = () => {
    if (!request || busy) return;
    mutation
      .mutateAsync({ operationId: createGitMutationOperationId(), selection: request })
      .then(onClose, (error: unknown) => {
        onClose();
        toastManager.add({
          type: "error",
          timeout: 8_000,
          title: "Unable to discard changes",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
  };

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {copy ? (
        <AlertDialogPopup
          className="max-w-lg p-0"
          bottomStickOnMobile={false}
          initialFocus={cancelButtonRef}
        >
          <ConfirmationPanel
            title={<span className="break-all">{copy.title}</span>}
            description={copy.description}
            cancelLabel="Cancel"
            confirmLabel={copy.confirmLabel}
            confirmVariant="destructive"
            busy={busy}
            cancelDisabled={busy}
            cancelButtonRef={cancelButtonRef}
            onCancel={onClose}
            onConfirm={confirm}
          />
        </AlertDialogPopup>
      ) : null}
    </AlertDialog>
  );
}
