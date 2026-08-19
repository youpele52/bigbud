import {
  FINITE_THREAD_RETENTION_POLICIES,
  THREAD_RETENTION_POLICIES,
  THREAD_RETENTION_POLICY_LABELS,
  type FiniteThreadRetentionPolicy,
  type ThreadRetentionPolicy,
} from "@bigbud/contracts/core/settings.threadRetention";
import type {
  ServerThreadRetentionPreview,
  ServerThreadRetentionResult,
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
import { ThreadBehaviorSettingsRows } from "./ThreadRetentionSettingsSection.behavior";
import { ThreadRetentionConfirmationContent } from "./ThreadRetentionConfirmationContent";
import {
  formatRetentionCleanupResult,
  getRetentionCleanupLoadingToast,
  getRetentionCleanupSuccessToast,
  getRetentionPolicyUpdatedToast,
} from "./ThreadRetentionSettingsSection.logic";

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
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [result, setResult] = useState<ServerThreadRetentionResult | null>(null);
  const busy = previewBusy || actionBusy;

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
    setPreviewError(null);
    setPreviewBusy(false);
  }, []);

  const requestPreview = useCallback(
    async (trigger: ThreadRetentionConsentTrigger, nextPolicy: FiniteThreadRetentionPolicy) => {
      const sequence = previewSequenceRef.current + 1;
      previewSequenceRef.current = sequence;
      setDialogTrigger(trigger);
      setDialogPolicy(nextPolicy);
      setPreview(null);
      setPreviewError(null);
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
        setPreviewError(
          error instanceof Error ? error.message : "Failed to preview thread retention.",
        );
      } finally {
        if (mountedRef.current && sequence === previewSequenceRef.current) setPreviewBusy(false);
      }
    },
    [],
  );

  const handlePolicyChange = useCallback(
    (nextPolicy: ThreadRetentionPolicy) => {
      if (nextPolicy === policy) return;
      if (nextPolicy === "never") {
        setActionBusy(true);
        void ensureNativeApi()
          .server.setThreadRetentionPolicy({ policy: "never" })
          .then(applySettingsUpdated)
          .catch((error) => showError("Unable to update automatic thread cleanup", error))
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
    const trigger = dialogTrigger;
    const challengeToken = preview.challenge.token;
    const nextPolicy = preview.policy;
    closeDialog();
    setActionBusy(true);
    try {
      if (trigger === "policy-change") {
        const settings = await ensureNativeApi().server.setThreadRetentionPolicy({
          policy: nextPolicy,
          challengeToken,
        });
        applySettingsUpdated(settings);
        toastManager.add({ type: "success", ...getRetentionPolicyUpdatedToast() });
        return;
      }
      const runPromise = ensureNativeApi().server.startThreadRetention({ challengeToken });
      toastManager.promise(runPromise, {
        loading: getRetentionCleanupLoadingToast(),
        success: (run) => getRetentionCleanupSuccessToast(run),
        error: (error) => ({
          title: "Unable to confirm thread cleanup",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      });
      const run = await runPromise;
      if (mountedRef.current) setResult(run);
    } catch (error) {
      if (trigger === "policy-change") showError("Unable to confirm thread cleanup", error);
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  }, [closeDialog, dialogTrigger, preview, requestPreview, showError]);

  const selectedLabel = THREAD_RETENTION_POLICY_LABELS[policy];
  const dialogTitle =
    dialogTrigger === "policy-change"
      ? `Delete old threads after ${THREAD_RETENTION_POLICY_LABELS[dialogPolicy]}?`
      : `Delete threads older than ${THREAD_RETENTION_POLICY_LABELS[manualPolicy]}?`;

  return (
    <>
      <SettingsSection title="Threads">
        <ThreadBehaviorSettingsRows />
        <SettingsRow
          title="Automatically delete old threads"
          searchTerms={["Automatic thread cleanup"]}
          description="The server checks daily using fixed 1, 2, 3, 7, 14, 30, or 90 day periods. Eligible root thread subtrees are cleaned up together. Pinned and active subtrees are skipped."
          layout="three-quarter-control"
          statusPlacement="below"
          status={
            result ? (
              <p className="text-xs text-muted-foreground">
                Latest cleanup: {formatRetentionCleanupResult(result)}
              </p>
            ) : null
          }
          control={
            <Select
              value={policy}
              disabled={busy}
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
                className="w-full"
                aria-label="Automatic thread cleanup period"
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
          description="Runs now across all projects. Choose the cutoff in the confirmation dialog. Automatic cleanup above is separate. Eligible root thread subtrees and their descendants are cleaned up together."
          layout="three-quarter-control"
          control={
            <Button
              ref={actionButtonRef}
              variant="destructive-outline"
              size="sm"
              className="w-full"
              disabled={busy}
              onClick={() => {
                void requestPreview("manual", manualPolicy);
              }}
            >
              <Trash2Icon />
              Delete now
            </Button>
          }
        />
      </SettingsSection>

      <AlertDialog
        open={dialogTrigger !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
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
            description="Thread cleanup confirmation"
            cancelLabel="Cancel"
            confirmLabel={
              dialogTrigger === "policy-change"
                ? "Enable automatic cleanup"
                : "Delete eligible threads"
            }
            confirmVariant="destructive"
            busy={actionBusy}
            cancelDisabled={false}
            cancelButtonRef={cancelButtonRef}
            confirmDisabled={
              previewBusy || !preview || (dialogTrigger === "manual" && preview.eligibleCount === 0)
            }
            onCancel={closeDialog}
            onConfirm={() => void confirmAction()}
            descriptionSlot={
              <div className="space-y-3">
                {dialogTrigger === "manual" ? (
                  <div className="pb-2">
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
                      <SelectTrigger
                        aria-label="One-off cleanup period"
                        className="w-full sm:w-1/3"
                      >
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
                  </div>
                ) : null}
                <ThreadRetentionConfirmationContent
                  preview={preview}
                  previewError={previewError}
                  trigger={dialogTrigger}
                />
              </div>
            }
          />
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
