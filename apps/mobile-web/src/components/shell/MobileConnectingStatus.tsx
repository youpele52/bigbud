import { useMobileRpcClient } from "../../context/MobileRpcContext";
import type { StoredMobileSession } from "../../lib/mobileSession";
import { diagnosticsInputFromConnection } from "../../logic/mobileConnectionDiagnostics.logic";
import { MobileConnectionDiagnostics } from "./MobileConnectionDiagnostics";

/** Redacted staged diagnostics for the current session's live connection. */
export function MobileSessionConnectionDetails({ session }: { session: StoredMobileSession }) {
  const { connection, recoveryState } = useMobileRpcClient();
  return (
    <MobileConnectionDiagnostics
      backendBaseUrl={session.backendBaseUrl}
      pageOrigin={window.location.origin}
      {...diagnosticsInputFromConnection({ connection, freshness: recoveryState.freshness })}
    />
  );
}

/**
 * Shown beneath the startup loader once a first connection has failed. A
 * failing first connection (typical off-network) can retry for roughly 20–40
 * seconds, so explain it instead of showing only the loader.
 */
export function MobileConnectingStatus({ session }: { session: StoredMobileSession }) {
  const { connection } = useMobileRpcClient();
  // The lifecycle escalates after 10 s without an open; `attempt` counts
  // attempts since the last open. Both stay stable while transport alternates
  // between connecting and retrying, so the status does not flicker.
  const stillConnecting =
    connection.transport !== "open" &&
    (connection.incidentLevel === "escalated" ||
      connection.attempt > 1 ||
      connection.browserOffline);
  if (!stillConnecting) return null;
  return (
    <div className="grid gap-2 text-center" role="status">
      <p className="text-sm text-muted-foreground">
        {connection.browserOffline
          ? "This phone is offline. Waiting for a connection."
          : `Still trying to reach the selected host (attempt ${connection.attempt}).`}
      </p>
      <div className="text-left">
        <MobileSessionConnectionDetails session={session} />
      </div>
    </div>
  );
}
