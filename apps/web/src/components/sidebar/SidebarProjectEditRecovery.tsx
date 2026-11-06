import { useState, type ReactNode } from "react";
import type { ProjectId } from "@bigbud/contracts";
import type { GetCommandOutcomeResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { OrchestrationCommandOutcomeError } from "../../lib/orchestrationCommandRecovery";
import {
  readProjectEditRecovery,
  clearProjectEdit,
  retryProjectEdit,
} from "./Sidebar.projectEdit.recovery";
import { Button } from "../ui/button";
import {
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function ProjectEditRecoveryGate(props: {
  projectId: ProjectId;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  children: (error: string | null) => ReactNode;
}) {
  const [saved, setSaved] = useState(() => {
    try {
      return { retained: readProjectEditRecovery(props.projectId), error: null };
    } catch (cause) {
      return { retained: null, error: String(cause) };
    }
  });
  const [error, setError] = useState<string | null>(saved.error ?? saved.retained?.error ?? null);
  const [outcome, setOutcome] = useState<GetCommandOutcomeResult | null>(null);
  const [busy, setBusy] = useState(false);
  if (!saved.retained && !saved.error) return props.children(error);
  const transition = outcome?.status === "unknown" ? outcome.workspaceTransition : undefined;
  const inspect = async (retry: boolean) => {
    if (busy || !saved.retained) return;
    setBusy(true);
    props.onBusyChange(true);
    try {
      const result = await ensureNativeApi().orchestration.getCommandOutcome({
        commandId: saved.retained.command.commandId,
      });
      setOutcome(result);
      if (result.status === "accepted") {
        clearProjectEdit(props.projectId);
        props.onClose();
      } else if (result.status === "rejected") {
        clearProjectEdit(props.projectId);
        setError(new OrchestrationCommandOutcomeError(result).message);
        setSaved({ retained: null, error: null });
      } else if (retry) {
        await retryProjectEdit(props.projectId);
        props.onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // A retry may have observed a definitive refusal. Only then unlock a new request.
      try {
        if (!readProjectEditRecovery(props.projectId)) setSaved({ retained: null, error: null });
      } catch {
        // Corruption is not a terminal outcome. Keep the recovery gate closed.
      }
    } finally {
      setBusy(false);
      props.onBusyChange(false);
    }
  };
  return (
    <DialogPopup className="max-w-sm" showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>Recover project edit</DialogTitle>
        <DialogDescription>
          Your original request is kept. Check its result before making another change.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-3 text-sm">
        {error ? (
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
        ) : null}
        {saved.retained ? (
          <p className="break-all text-xs">Request ID: {saved.retained.command.commandId}</p>
        ) : null}
        {transition ? (
          <div className="space-y-2 text-xs">
            <p>Transition: {transition.phase}</p>
            <p className="break-all">Original: {transition.sourcePath}</p>
            <p className="break-all">Destination: {transition.destinationPath}</p>
            {transition.error ? <p role="alert">{transition.error}</p> : null}
            {transition.steps.map((step) => (
              <p
                className="break-all"
                key={`${step.threadId}:${step.provider}:${step.nativeSessionId}`}
              >
                {step.threadId} · {step.provider} · {step.nativeSessionId}: {step.phase}
              </p>
            ))}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Recovery never creates a replacement request, repeats an uncertain native move, or replays
          chat history. Original folders remain available.
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
          Close
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !saved.retained}
          onClick={() => void inspect(false)}
        >
          Check status
        </Button>
        <Button type="button" disabled={busy || !saved.retained} onClick={() => void inspect(true)}>
          {busy ? "Checking…" : "Retry exact edit"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
