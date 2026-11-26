import { useEffect, useMemo, useRef } from "react";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  describeTerminalLimitPrompt,
  TERMINAL_LIMIT_DIALOG_TITLE,
  TERMINAL_LIMIT_EVICT_LABEL,
} from "./TerminalLimitDialog.logic";
import { resolveTerminalNoticeNames } from "./terminalLifecycle.labels";
import {
  registerTerminalLimitPromptHost,
  resolveTerminalLimitPrompt,
  useTerminalLimitPromptStore,
} from "./terminalLimitPrompt";

/**
 * Hosts `promptTerminalLimit`: shows the oldest waiting refusal and settles it. Cancel, Escape
 * and the backdrop all cancel; only the destructive button evicts.
 */
export function TerminalLimitDialog() {
  const request = useTerminalLimitPromptStore((state) => state.queue[0] ?? null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => registerTerminalLimitPromptHost(), []);
  const copy = useMemo(() => {
    if (!request) return null;
    const { candidate } = request.input;
    const names = candidate
      ? resolveTerminalNoticeNames(candidate.threadId, candidate.terminalId)
      : null;
    return describeTerminalLimitPrompt(request.input, names);
  }, [request]);

  const settle = (decision: "evict" | "cancel") => {
    if (request) resolveTerminalLimitPrompt(request.id, decision);
  };

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle("cancel");
      }}
    >
      <AlertDialogPopup
        className="max-w-md p-0"
        bottomStickOnMobile={false}
        initialFocus={cancelButtonRef}
        data-testid="terminal-limit-dialog"
      >
        <div className="flex max-h-full min-h-0 flex-col gap-3 p-4 sm:p-5">
          <div className="min-h-0 space-y-1.5 overflow-y-auto overscroll-contain">
            <AlertDialogTitle className="text-sm font-medium text-foreground/90">
              {TERMINAL_LIMIT_DIALOG_TITLE}
            </AlertDialogTitle>
            <AlertDialogDescription
              render={<div />}
              className="space-y-1.5 text-sm leading-5 font-normal text-foreground/80"
            >
              <p>{copy?.body}</p>
              {copy?.candidateLine ? (
                <p className="text-xs text-muted-foreground">{copy.candidateLine}</p>
              ) : null}
            </AlertDialogDescription>
          </div>
          <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            {copy?.candidateLine ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-auto text-destructive whitespace-normal hover:bg-destructive/10 hover:text-destructive"
                onClick={() => settle("evict")}
              >
                {TERMINAL_LIMIT_EVICT_LABEL}
              </Button>
            ) : null}
            <Button
              ref={cancelButtonRef}
              size="sm"
              variant="outline"
              onClick={() => settle("cancel")}
            >
              Cancel
            </Button>
          </div>
        </div>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
