import { useEffect, useState } from "react";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import { Button } from "./ui/button";

const manual = "Close the other bigbud app or backend, then quit and reopen this app.";

export function OwnershipRecovery({ startup }: { readonly startup: DesktopBackendStartupState }) {
  const [requestPending, setRequestPending] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const recover = window.desktopBridge?.recoverBackendOwnership;
  const check = window.desktopBridge?.checkBackendOwnership;
  const recovery = startup.ownershipRecovery;
  const busy =
    requestPending ||
    recovery?.phase === "checking" ||
    recovery?.phase === "stopping" ||
    recovery?.phase === "retrying";
  const yielded = recovery?.phase === "yielded";
  useEffect(() => {
    if (!yielded && check) void check(startup.generation).catch(() => setRequestFailed(true));
  }, [check, startup.generation, yielded]);
  const failed = recovery?.phase === "failed" || requestFailed;
  const message = yielded
    ? "This window yielded backend control so another bigbud window could use the local data. Automatic restarts are paused; the backend may still be running or stopping. Quit and reopen this window to use it again."
    : recovery?.phase === "checking"
      ? "Checking backend…"
      : recovery?.phase === "stopping"
        ? "Stopping other backend…"
        : recovery?.phase === "retrying"
          ? "Starting bigbud…"
          : failed
            ? recovery?.error === "shutdown_timed_out"
              ? `The other backend may still be stopping. ${manual}`
              : `This backend could not be stopped safely. ${manual}`
            : recover
              ? "Stopping the other backend will interrupt its active work. Only verified, compatible local desktop backends can be stopped automatically."
              : manual;
  return (
    <div className="mt-5 space-y-3 text-sm">
      <p role="status" aria-live="polite">
        {message}
      </p>
      {recover && !yielded && (recovery?.phase === "available" || busy) ? (
        <Button
          disabled={busy}
          onClick={async () => {
            setRequestPending(true);
            setRequestFailed(false);
            try {
              await recover(startup.generation);
            } catch {
              setRequestFailed(true);
            } finally {
              setRequestPending(false);
            }
          }}
        >
          {busy ? "Please wait…" : "Stop other backend and retry"}
        </Button>
      ) : null}
    </div>
  );
}
