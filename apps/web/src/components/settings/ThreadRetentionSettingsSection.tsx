import {
  FINITE_THREAD_RETENTION_POLICIES,
  THREAD_RETENTION_POLICIES,
  THREAD_RETENTION_POLICY_LABELS,
  type FiniteThreadRetentionPolicy,
  type ThreadRetentionPolicy,
} from "@bigbud/contracts/core/settings.threadRetention";
import type {
  ServerThreadRetentionPreview,
  ThreadRetentionConsentTrigger,
} from "@bigbud/contracts/server/threadRetention";
import { Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { applySettingsUpdated } from "../../rpc/serverState";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { ThreadRetentionConfirmationContent } from "./ThreadRetentionConfirmationContent";
import { ThreadRetentionRunStatus } from "./ThreadRetentionRunStatus";
import { isActiveRetentionRun } from "./ThreadRetentionSettingsSection.logic";
import { useThreadRetentionRun } from "./useThreadRetentionRun";

export function ThreadRetentionSettingsSection() {
  const policy = useSettings().threadRetentionPolicy;
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const policyTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previewSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const [manualPolicy, setManualPolicy] = useState<FiniteThreadRetentionPolicy>("7-days");
  const [dialogTrigger, setDialogTrigger] = useState<ThreadRetentionConsentTrigger | null>(null);
  const [dialogPolicy, setDialogPolicy] = useState<FiniteThreadRetentionPolicy>("7-days");
  const [preview, setPreview] = useState<ServerThreadRetentionPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const { latestRun, pollingError, availability, acceptRun, retryPolling } =
    useThreadRetentionRun();
  const busy = previewBusy || actionBusy;
  const maintenanceActive = latestRun ? isActiveRetentionRun(latestRun) : false;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewSequenceRef.current += 1;
    };
  }, []);

  const showError = useCallback((title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }, []);

  const closeDialog = useCallback(() => {
    previewSequenceRef.current += 1;
    setDialogTrigger(null);
    setPreview(null);
    setPreviewBusy(false);
  }, []);

  const requestPreview = useCallback(
    async (trigger: ThreadRetentionConsentTrigger, nextPolicy: FiniteThreadRetentionPolicy) => {
      const sequence = previewSequenceRef.current + 1;
      previewSequenceRef.current = sequence;
      setDialogTrigger(trigger);
      setDialogPolicy(nextPolicy);
      setPreview(null);
      setPreviewBusy(true);
      try {
        const result = await ensureNativeApi().server.previewThreadRetention({
          trigger,
          policy: nextPolicy,
        });
        if (!mountedRef.current || sequence !== previewSequenceRef.current) return;
        setPreview(result);
      } catch (error) {
        if (!mountedRef.current || sequence !== previewSequenceRef.current) return;
        closeDialog();
        showError("Unable to preview thread retention", error);
      } finally {
        if (mountedRef.current && sequence === previewSequenceRef.current) setPreviewBusy(false);
      }
    },
    [closeDialog, showError],
  );

  const handlePolicyChange = useCallback(
    (nextPolicy: ThreadRetentionPolicy) => {
      if (nextPolicy === policy) return;
      if (nextPolicy === "never") {
        setActionBusy(true);
        void ensureNativeApi()
          .server.setThreadRetentionPolicy({ policy: "never" })
          .then(applySettingsUpdated)
          .catch((error) => showError("Unable to update thread retention", error))
          .finally(() => {
            if (mountedRef.current) setActionBusy(false);
          });
        return;
      }
      void requestPreview("policy-change", nextPolicy);
    },
    [policy, requestPreview, showError],
  );

  const confirmAction = useCallback(async () => {
    if (!preview || !dialogTrigger) return;
    if (Date.parse(preview.challenge.expiresAt) <= Date.now()) {
      await requestPreview(dialogTrigger, preview.policy);
      return;
    }
    setActionBusy(true);
    try {
      if (dialogTrigger === "policy-change") {
        const settings = await ensureNativeApi().server.setThreadRetentionPolicy({
          policy: preview.policy,
          challengeToken: preview.challenge.token,
        });
        applySettingsUpdated(settings);
      } else {
        const run = await ensureNativeApi().server.startThreadRetention({
          challengeToken: preview.challenge.token,
        });
        acceptRun(run);
      }
      closeDialog();
    } catch (error) {
      showError("Unable to confirm thread retention", error);
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  }, [acceptRun, closeDialog, dialogTrigger, preview, requestPreview, showError]);

  const selectedLabel = THREAD_RETENTION_POLICY_LABELS[policy];
  const dialogTitle =
    dialogTrigger === "policy-change"
      ? `Enable ${THREAD_RETENTION_POLICY_LABELS[dialogPolicy]} retention?`
      : "Permanently delete eligible threads?";

  return (
    <>
      <SettingsSection title="Thread retention">
        <SettingsRow
          title="Automatic retention"
          description="Uses fixed 7, 14, 30, or 90 day periods. Safety checks preserve pinned, active, queued, waiting, watched, and delegated threads."
          status={
            <ThreadRetentionRunStatus
              run={latestRun}
              pollingError={pollingError}
              availability={availability}
              onRetry={retryPolling}
            />
          }
          control={
            <Select
              value={policy}
              disabled={busy || availability === "loading"}
              onValueChange={(value) => {
                if (
                  typeof value === "string" &&
                  (THREAD_RETENTION_POLICIES as readonly string[]).includes(value)
                ) {
                  handlePolicyChange(value as ThreadRetentionPolicy);
                }
              }}
            >
              <SelectTrigger
                ref={policyTriggerRef}
                className="w-full sm:w-40"
                aria-label="Thread retention policy"
              >
                <SelectValue>{selectedLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THREAD_RETENTION_POLICIES.map((value) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {THREAD_RETENTION_POLICY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Delete eligible threads now"
          description="Deletes eligible threads across all projects using the selected retention period and cannot be undone. If retention is set to Never, you can choose a one-off period before confirming. Protected and active threads are always preserved."
          control={
            <Button
              ref={actionButtonRef}
              variant="destructive-outline"
              size="sm"
              disabled={busy || availability !== "available" || maintenanceActive}
              onClick={() => {
                const nextPolicy = policy === "never" ? manualPolicy : policy;
                void requestPreview("manual", nextPolicy);
              }}
            >
              <Trash2Icon />
              Delete eligible threads now
            </Button>
          }
        />
      </SettingsSection>

      <AlertDialog
        open={dialogTrigger !== null}
        onOpenChange={(open) => {
          if (!open && !actionBusy) closeDialog();
        }}
      >
        <AlertDialogPopup
          className="max-w-lg p-0"
          bottomStickOnMobile={false}
          initialFocus={cancelButtonRef}
          finalFocus={dialogTrigger === "policy-change" ? policyTriggerRef : actionButtonRef}
        >
          <ConfirmationPanel
            title={dialogTitle}
            description="Thread retention confirmation"
            cancelLabel="Cancel"
            confirmLabel={
              dialogTrigger === "policy-change" ? "Enable retention" : "Delete threads permanently"
            }
            confirmVariant="destructive"
            busy={actionBusy}
            cancelButtonRef={cancelButtonRef}
            confirmDisabled={
              previewBusy ||
              !preview ||
              (dialogTrigger === "manual" &&
                (preview.eligibleCount === 0 || preview.maintenanceState !== "available"))
            }
            onCancel={closeDialog}
            onConfirm={() => void confirmAction()}
            descriptionSlot={
              <div className="space-y-3">
                {dialogTrigger === "manual" && policy === "never" ? (
                  <Select
                    value={manualPolicy}
                    disabled={actionBusy || previewBusy}
                    onValueChange={(value) => {
                      if (
                        typeof value === "string" &&
                        (FINITE_THREAD_RETENTION_POLICIES as readonly string[]).includes(value)
                      ) {
                        const nextPolicy = value as FiniteThreadRetentionPolicy;
                        setManualPolicy(nextPolicy);
                        void requestPreview("manual", nextPolicy);
                      }
                    }}
                  >
                    <SelectTrigger aria-label="One-off retention period" className="w-full">
                      <SelectValue>{THREAD_RETENTION_POLICY_LABELS[manualPolicy]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {FINITE_THREAD_RETENTION_POLICIES.map((value) => (
                        <SelectItem hideIndicator key={value} value={value}>
                          {THREAD_RETENTION_POLICY_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                <ThreadRetentionConfirmationContent preview={preview} trigger={dialogTrigger} />
              </div>
            }
          />
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
