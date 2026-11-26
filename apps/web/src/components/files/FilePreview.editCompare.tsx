import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import type { FileEditDraft } from "./fileEditDrafts";
import {
  discardConflictedFileEditDraft,
  getFileEditDiskVersion,
  keepMineFileEditDraft,
} from "./fileEditDrafts";

interface FilePreviewEditCompareProps {
  readonly draft: FileEditDraft;
  readonly draftKey: string;
}

/**
 * Shows the verified disk version beside the draft. "Keep mine" is bound to the exact disk
 * version displayed here, so a change made after the dialog opened stops the save again.
 */
export function FilePreviewEditCompare({ draft, draftKey }: FilePreviewEditCompareProps) {
  const [shown, setShown] = useState<{ contents: string; hash: string } | null>(null);
  return (
    <Dialog
      open={shown !== null}
      onOpenChange={(open) => {
        if (!open) setShown(null);
      }}
    >
      <Button size="xs" variant="ghost" onClick={() => setShown(getFileEditDiskVersion(draftKey))}>
        Compare
      </Button>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>The file changed on disk</DialogTitle>
          <DialogDescription>
            Keep your draft to overwrite exactly the version shown here, or use the version on disk
            and discard your draft.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid grid-cols-2 gap-3 text-xs">
          {[
            ["On disk", shown?.contents ?? ""],
            ["Your draft", draft.contents],
          ].map(([label, text]) => (
            <section key={label} className="min-w-0">
              <h3 className="mb-1 font-medium text-muted-foreground">{label}</h3>
              <pre className="max-h-96 overflow-auto rounded border border-border p-2 whitespace-pre-wrap">
                {text}
              </pre>
            </section>
          ))}
        </DialogPanel>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              discardConflictedFileEditDraft(draftKey);
              setShown(null);
            }}
          >
            Use disk version
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (shown) keepMineFileEditDraft(draftKey, shown.hash);
              setShown(null);
            }}
          >
            Keep mine
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
