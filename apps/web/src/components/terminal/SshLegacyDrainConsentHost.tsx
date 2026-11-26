import { useCallback, useEffect, useState } from "react";

import type {
  BackendDrainConsentSnapshot,
  BackendDrainDecision,
} from "@bigbud/contracts/server/backendDrain.ts";
import { readNativeApi } from "../../rpc/nativeApi";
import { SshLegacyDrainDialog } from "./SshLegacyDrainDialog";
import type { SshLegacyDrainFlow } from "./SshLegacyDrainDialog.types";

const POLL_MS = 1_000;

const surfaceLabel = {
  local: "local terminal",
  "direct-ssh": "direct SSH",
  "remote-agent": "remote agent",
} as const;

/**
 * Polls the authenticated backend consent RPC and renders the existing dialog.
 * A reconnect simply reads the current snapshot again; it never starts a drain.
 * One decision is sent per drain and late/duplicate choices close without retry.
 */
export function SshLegacyDrainConsentHost() {
  const [pending, setPending] = useState<BackendDrainConsentSnapshot | null>(null);
  const [phase, setPhase] = useState<"review" | "submitting" | "error" | "closed">("closed");
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    try {
      const next = await api.server.getBackendDrainConsent();
      setPending(next);
      setPhase(next ? "review" : "closed");
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The drain consent could not be read.");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!pending) void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  const decide = (decision: BackendDrainDecision) => {
    const api = readNativeApi();
    if (!api || !pending) return;
    setPhase("submitting");
    void api.server
      .decideBackendDrainConsent({ drainId: pending.drainId, decision })
      .then((result) => {
        if (result.status === "accepted" || result.status === "already-decided") {
          setPending(null);
          setPhase("closed");
          return;
        }
        setError("This drain is no longer pending.");
        setPhase("error");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "The drain decision was refused.");
        setPhase("error");
      });
  };

  if (!pending) return null;
  const flow: SshLegacyDrainFlow = {
    phase,
    reason: "upgrade",
    panes: pending.panes.map((pane) => ({
      paneId: pane.paneId,
      threadId: pane.threadId,
      threadTitle: pane.threadTitle,
      paneTitle: pane.paneTitle,
      route: surfaceLabel[pane.surface],
    })),
    ...(error ? { error } : {}),
    saveAndClose: () => decide("save-and-close"),
    drainNow: () => decide("drain-now"),
    cancel: () => decide("cancel"),
    retry: () => {
      setPhase("review");
      setError(undefined);
      void refresh();
    },
  };
  return <SshLegacyDrainDialog flow={flow} />;
}
