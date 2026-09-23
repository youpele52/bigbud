import {
  FINITE_THREAD_RETENTION_POLICIES,
  THREAD_RETENTION_POLICIES,
  THREAD_RETENTION_POLICY_LABELS,
  type FiniteThreadRetentionPolicy,
  type ThreadRetentionAgeCriterion,
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
import { ThreadBehaviorSettingsRows } from "./ThreadRetentionSettingsSection.behavior";
import { ThreadRetentionConfirmationContent } from "./ThreadRetentionConfirmationContent";
import { ThreadRetentionCriterionSelect } from "./ThreadRetentionCriterionSelect";
import {
  formatRetentionResourceOutcomes,
  useThreadRetentionProgress,
} from "./ThreadRetentionSettingsSection.progress";
import {
  getRetentionRunStatusMessage,
  getRetentionPolicyUpdatedToast,
} from "./ThreadRetentionSettingsSection.logic";

export function ThreadRetentionSettingsSection() {
  const policy = useSettings().threadRetentionPolicy;
  const progress = useThreadRetentionProgress();
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const policyTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previewSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const [manualPolicy, setManualPolicy] = useState<FiniteThreadRetentionPolicy>("7-days");
  const [manualCriterion, setManualCriterion] = useState<ThreadRetentionAgeCriterion>(
    "last-conversation-activity",
  );
  const [automaticCriterion, setAutomaticCriterion] = useState<ThreadRetentionAgeCriterion>(
    "last-conversation-activity",
  );
  const [dialogTrigger, setDialogTrigger] = useState<ThreadRetentionConsentTrigger | null>(null);
  const [dialogPolicy, setDialogPolicy] = useState<FiniteThreadRetentionPolicy>("7-days");
  const [dialogCriterion, setDialogCriterion] = useState<ThreadRetentionAgeCriterion>(
    "last-conversation-activity",
  );
  const [preview, setPreview] = useState<ServerThreadRetentionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const busy = previewBusy || actionBusy;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewSequenceRef.current += 1;
    };
  }, []);

  useEffect(() => setAutomaticCriterion(progress.policyCriterion), [progress.policyCriterion]);

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

  const cancelDialog = useCallback(() => {
    if (dialogTrigger === "policy-change") setAutomaticCriterion(progress.policyCriterion);
    closeDialog();
  }, [closeDialog, dialogTrigger, progress.policyCriterion]);

  const requestPreview = useCallback(
    async (
      trigger: ThreadRetentionConsentTrigger,
      nextPolicy: FiniteThreadRetentionPolicy,
      criterion: ThreadRetentionAgeCriterion,
    ) => {
      const sequence = previewSequenceRef.current + 1;
      previewSequenceRef.current = sequence;
      setDialogTrigger(trigger);
      setDialogPolicy(nextPolicy);
      setDialogCriterion(criterion);
      setPreview(null);
      setPreviewError(null);
      setPreviewBusy(true);
      try {
        const result = await ensureNativeApi().server.previewThreadRetention({
          trigger,
          policy: nextPolicy,
          ageCriterion: criterion,
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
      if (
        nextPolicy === policy &&
        progress.policyMode === "per-thread" &&
        automaticCriterion === progress.policyCriterion
      )
        return;
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
      void requestPreview("policy-change", nextPolicy, automaticCriterion);
    },
    [
      policy,
      progress.policyMode,
      progress.policyCriterion,
      automaticCriterion,
      requestPreview,
      showError,
    ],
  );

  const confirmAction = useCallback(async () => {
    if (!preview || !dialogTrigger) return;
    if (Date.parse(preview.challenge.expiresAt) <= Date.now()) {
      await requestPreview(dialogTrigger, preview.policy, dialogCriterion);
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
          ageCriterion: dialogCriterion,
          challengeToken,
        });
        applySettingsUpdated(settings);
        void progress.refreshRecent().catch(() => {});
        toastManager.add({ type: "success", ...getRetentionPolicyUpdatedToast() });
        return;
      }
      try {
        const run = await ensureNativeApi().server.startThreadRetention({ challengeToken });
        progress.beginRun(run);
      } catch (error) {
        toastManager.add({
          type: "error",
          timeout: 5_000,
          title: "Unable to confirm thread cleanup",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    } catch (error) {
      if (trigger === "policy-change") showError("Unable to confirm thread cleanup", error);
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  }, [closeDialog, dialogTrigger, dialogCriterion, preview, progress, requestPreview, showError]);

  const selectedLabel =
    policy !== "never" && progress.policyMode !== "per-thread"
      ? `${THREAD_RETENTION_POLICY_LABELS[policy]} · Legacy subtree cleanup`
      : THREAD_RETENTION_POLICY_LABELS[policy];
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
          description="The server checks daily. New policies delete eligible threads individually using the selected age rule. Existing legacy policies keep subtree cleanup until you review and change them."
          layout="three-quarter-control"
          statusPlacement="below"
          status={
            progress.run ? (
              <p className="text-xs text-muted-foreground">
                {getRetentionRunStatusMessage(progress.run)}
                {formatRetentionResourceOutcomes(progress.run)
                  ? ` · ${formatRetentionResourceOutcomes(progress.run)}`
                  : ""}
              </p>
            ) : progress.recentRuns[0] ? (
              <p className="text-xs text-muted-foreground">
                Latest cleanup: {progress.recentRuns[0].completedCount} threads deleted ·{" "}
                {progress.recentRuns[0].status.replaceAll("_", " ")}
                {formatRetentionResourceOutcomes(progress.recentRuns[0])
                  ? ` · ${formatRetentionResourceOutcomes(progress.recentRuns[0])}`
                  : ""}
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
                variant="muted-outline"
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
          title="Automatic cleanup age rule"
          description="Created uses the thread's creation time. Last conversation activity uses the latest user message, or creation if there is none."
          layout="three-quarter-control"
          control={
            <ThreadRetentionCriterionSelect
              value={automaticCriterion}
              disabled={busy}
              label="Automatic cleanup age rule"
              onChange={(criterion) => {
                setAutomaticCriterion(criterion);
                if (policy !== "never") void requestPreview("policy-change", policy, criterion);
              }}
            />
          }
        />
        <SettingsRow
          title="Delete eligible threads now"
          description="Runs across all projects. Choose a period and age rule in the confirmation dialog. Eligible threads are deleted individually; surviving children are kept."
          layout="three-quarter-control"
          control={
            <Button
              ref={actionButtonRef}
              variant="outline"
              size="sm"
              className="w-full font-normal text-xs text-destructive [:hover,:active,[data-pressed]]:text-destructive"
              disabled={busy}
              onClick={() => {
                void requestPreview("manual", manualPolicy, manualCriterion);
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
          if (!open) cancelDialog();
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
            onCancel={cancelDialog}
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
                          void requestPreview("manual", nextPolicy, manualCriterion);
                        }
                      }}
                    >
                      <SelectTrigger
                        variant="muted-outline"
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
                    <ThreadRetentionCriterionSelect
                      value={manualCriterion}
                      disabled={actionBusy || previewBusy}
                      label="One-off cleanup age rule"
                      onChange={(criterion) => {
                        setManualCriterion(criterion);
                        void requestPreview("manual", manualPolicy, criterion);
                      }}
                    />
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
