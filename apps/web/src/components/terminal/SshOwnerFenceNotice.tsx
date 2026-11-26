import { useCallback, useEffect, useState } from "react";

import type { SshOwnerAdmissionSnapshot } from "@bigbud/contracts/server/sshOwnerAdmission.ts";
import { readNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import { SshLegacyDrainDialog } from "./SshLegacyDrainDialog";
import type { SshLegacyDrainFlow } from "./SshLegacyDrainDialog.types";

const POLL_MS = 5_000;

type Fenced = Extract<SshOwnerAdmissionSnapshot, { readonly state: "fenced" }>;

/**
 * W3.6 / U8: when an activated backend fences SSH with `legacyEntryFenced`, an
 * amber notice offers the explicit drain. Reading never drains; only "Drain
 * identified panes" calls the server, and Cancel just closes the dialog.
 */
export function SshOwnerFenceNotice() {
  const [fenced, setFenced] = useState<Fenced | null>(null);
  const [phase, setPhase] = useState<SshLegacyDrainFlow["phase"]>("closed");
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    try {
      const next = await api.server.getSshOwnerAdmission();
      setFenced(next.state === "fenced" ? next : null);
    } catch {
      // A transient read failure keeps the last known state; the poll retries.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (!fenced) return null;

  const drain = () => {
    const api = readNativeApi();
    if (!api) return;
    setPhase("submitting");
    void api.server
      .drainSshOwnerIdentifiedPanes()
      .then((next) => {
        setFenced(next.state === "fenced" ? next : null);
        setPhase("closed");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "The drain was refused.");
        setPhase("error");
      });
  };

  const flow: SshLegacyDrainFlow = {
    reason: "startup-refusal",
    phase,
    panes: fenced.panes.map((pane) => ({
      paneId: pane.identity,
      threadId: pane.threadId,
      threadTitle: pane.threadId,
      paneTitle: pane.paneId,
      route: "SSH terminal on the previous terminal host",
    })),
    error: error ?? fenced.listError,
    saveAndClose: drain,
    drainNow: drain,
    cancel: () => setPhase("closed"),
    retry: () => {
      setError(undefined);
      setPhase("review");
      void refresh();
    },
  };

  return (
    <>
      <div
        role="status"
        className="fixed right-3 bottom-3 z-40 max-w-sm space-y-2 rounded-md border border-amber-500/40 bg-background p-3 shadow-md"
      >
        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">SSH is paused</p>
        <p className="text-xs leading-4 text-muted-foreground">{fenced.message}</p>
        <Button size="sm" variant="outline" onClick={() => setPhase("review")}>
          Review drain
        </Button>
      </div>
      <SshLegacyDrainDialog flow={flow} />
    </>
  );
}
