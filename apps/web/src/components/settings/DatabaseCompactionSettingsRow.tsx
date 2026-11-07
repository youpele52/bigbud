import { AlertTriangleIcon, DatabaseIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import {
  describeCompactionRow,
  getCompactionConfirmState,
  getCompactionPreviewItems,
} from "./DatabaseCompaction.logic";
import { useDatabaseCompaction } from "./DatabaseCompaction.progress";

/** Settings > Threads > "Compact database": a preview, then a confirmation, like "Delete now". */
export function DatabaseCompactionSettingsRow() {
  const compaction = useDatabaseCompaction();
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const row = describeCompactionRow({
    preview: compaction.preview,
    error: compaction.previewError,
    running: compaction.running,
  });
  const confirm = getCompactionConfirmState({
    preview: compaction.preview,
    previewBusy: compaction.previewBusy,
    actionBusy,
  });
  const { refreshPreview, start } = compaction;

  const openDialog = useCallback(() => {
    setDialogOpen(true);
    void refreshPreview();
  }, [refreshPreview]);

  const confirmCompaction = useCallback(async () => {
    setActionBusy(true);
    try {
      await start();
      setDialogOpen(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        timeout: 8_000,
        title: "Unable to compact the database",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      void refreshPreview();
    } finally {
      setActionBusy(false);
    }
  }, [refreshPreview, start]);

  return (
    <>
      <SettingsRow
        title="Compact database"
        searchTerms={["Database size", "Reclaim disk space", "Vacuum"]}
        description="Rebuilds the database file so space freed by cleanup returns to disk. Offered when free space exceeds 25% of the file and 500 MB. bigbud is paused while it runs."
        layout="three-quarter-control"
        statusPlacement="below"
        status={
          <p className="text-xs text-muted-foreground" data-testid="database-compaction-summary">
            {row.summary}
          </p>
        }
        control={
          <Button
            ref={actionButtonRef}
            variant="outline"
            size="sm"
            className="w-full font-normal text-xs"
            disabled={!row.actionEnabled || actionBusy}
            onClick={openDialog}
          >
            <DatabaseIcon />
            Compact
          </Button>
        }
      />

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setDialogOpen(false);
        }}
      >
        <AlertDialogPopup
          className="max-w-lg p-0"
          bottomStickOnMobile={false}
          initialFocus={cancelButtonRef}
          finalFocus={actionButtonRef}
        >
          <ConfirmationPanel
            title="Compact the database?"
            description="Database compaction confirmation"
            cancelLabel="Cancel"
            confirmLabel="Compact database"
            busy={actionBusy}
            cancelDisabled={actionBusy}
            cancelButtonRef={cancelButtonRef}
            confirmDisabled={!confirm.canConfirm}
            onCancel={() => setDialogOpen(false)}
            onConfirm={() => void confirmCompaction()}
            descriptionSlot={
              <div className="space-y-3">
                {compaction.previewError ? (
                  <p role="alert" className="font-medium text-destructive">
                    {compaction.previewError}
                  </p>
                ) : compaction.preview && !compaction.previewBusy ? (
                  <>
                    <dl
                      aria-label="Compaction preview"
                      className="grid grid-cols-2 gap-x-4 gap-y-1"
                    >
                      {getCompactionPreviewItems(compaction.preview).map((item) => (
                        <div key={item.label} className="contents">
                          <dt>{item.label}</dt>
                          <dd className="text-foreground">{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p>
                      Compaction rewrites the database without its free space. No threads, messages
                      or settings are removed. If it is interrupted, the database stays as it was.
                    </p>
                    {confirm.blockers.length > 0 ? (
                      <div
                        role="alert"
                        data-testid="database-compaction-blockers"
                        className="font-medium text-warning"
                      >
                        <p>Compaction cannot start yet</p>
                        <ul className="list-disc pl-5">
                          {confirm.blockers.map((blocker) => (
                            <li key={blocker}>{blocker}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p role="status" aria-live="polite">
                    Measuring the database…
                  </p>
                )}
                <p className="flex items-start gap-2 font-medium text-foreground">
                  <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  bigbud is paused until compaction finishes. Running turns, sync and other actions
                  wait for it.
                </p>
              </div>
            }
          />
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
