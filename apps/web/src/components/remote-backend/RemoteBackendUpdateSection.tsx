import { useMemo, useSyncExternalStore } from "react";
import { APP_VERSION } from "../../config/branding";
import {
  readBackendScope,
  readBoundBackendHandshake,
  subscribeBackendScope,
} from "../../rpc/backendScope.state";
import { getWsRpcClient } from "../../rpc/wsRpcClient";
import type { RemoteRuntimeUpdateRpcMethods } from "../../rpc/wsRpcClient.remoteBackendUpdate";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { useRemoteBackendUpdate } from "./RemoteBackendUpdate.hooks";
import { useInterruptFlow } from "./RemoteBackendUpdate.interrupt";
import {
  describeUpdateState,
  liveOperation,
  resolveUpdateAvailability,
  resolveUpdateTarget,
} from "./RemoteBackendUpdate.logic";
import { RemoteBackendUpdateInterruptDialog } from "./RemoteBackendUpdateInterruptDialog";

function boundUpdateClient(): RemoteRuntimeUpdateRpcMethods | null {
  try {
    return getWsRpcClient().server;
  } catch {
    // BoundBackendNotReadyError: the window is between connections.
    return null;
  }
}

/** Settings > About in a bound remote-backend window only. Local windows render nothing. */
export function RemoteBackendUpdateSection({
  client: injected,
  localVersion = APP_VERSION,
  pollMs,
}: {
  readonly client?: RemoteRuntimeUpdateRpcMethods;
  readonly localVersion?: string;
  readonly pollMs?: { readonly live: number; readonly idle: number };
}) {
  const scope = useSyncExternalStore(subscribeBackendScope, readBackendScope, readBackendScope);
  const availability = resolveUpdateAvailability(scope, readBoundBackendHandshake());
  if (availability.kind === "hidden") return null;
  return (
    <SettingsSection title="Remote backend">
      {availability.kind === "unsupported" ? (
        <UnavailableRow
          backendVersion={availability.backendVersion}
          reason="This backend does not offer runtime updates. Update it from the main window's remote setup instead."
        />
      ) : (
        <AvailableUpdateRows
          injected={injected}
          backendVersion={availability.backendVersion}
          localVersion={localVersion}
          pollMs={pollMs}
        />
      )}
    </SettingsSection>
  );
}

function UnavailableRow({
  backendVersion,
  reason,
}: {
  readonly backendVersion: string | null;
  readonly reason: string;
}) {
  return (
    <SettingsRow
      title="Runtime update"
      description={backendVersion ? `Remote backend version ${backendVersion}.` : "Remote backend."}
      status={
        <p className="text-xs text-muted-foreground" data-testid="remote-update-unavailable">
          Not available on this backend. {reason}
        </p>
      }
      statusPlacement="below"
    />
  );
}

function AvailableUpdateRows({
  injected,
  backendVersion,
  localVersion,
  pollMs,
}: {
  readonly injected: RemoteRuntimeUpdateRpcMethods | undefined;
  readonly backendVersion: string;
  readonly localVersion: string;
  readonly pollMs: { readonly live: number; readonly idle: number } | undefined;
}) {
  const client = useMemo(() => injected ?? boundUpdateClient(), [injected]);
  const model = useRemoteBackendUpdate(client, pollMs);
  const interrupt = useInterruptFlow(client, () => void model.refresh());
  if (model.refused)
    return <UnavailableRow backendVersion={backendVersion} reason={model.refused} />;

  const status = model.status;
  const live = liveOperation(status);
  const presentation = status ? describeUpdateState(status) : null;
  const target = resolveUpdateTarget(localVersion, backendVersion);
  const canRequest = status !== null && !live && target.kind === "requestable" && !model.busy;
  const targetNote =
    target.kind === "current"
      ? "Up to date with this computer."
      : target.kind === "invalid"
        ? `This computer's version (${target.version}) cannot be used as an update target.`
        : `This computer runs ${target.version}.`;

  return (
    <SettingsRow
      title="Runtime update"
      description={`Remote backend version ${backendVersion}. ${targetNote}`}
      layout="three-quarter-control"
      statusPlacement="below"
      control={
        <Button
          size="sm"
          variant="outline"
          className="w-full font-normal text-xs"
          disabled={!canRequest}
          onClick={() => void model.requestUpdate(target.version)}
        >
          Update to {target.version}
        </Button>
      }
      status={
        <div className="space-y-2" data-testid="remote-update-status">
          {presentation ? (
            <Alert variant={presentation.tone} data-update-state={status?.operation?.state}>
              <AlertTitle>{presentation.title}</AlertTitle>
              <AlertDescription>
                <p>{presentation.description}</p>
                {presentation.reasons.length > 0 ? (
                  <ul aria-label="Blocking work" className="list-disc pl-5 text-xs">
                    {presentation.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
                {live?.consent === "recorded" ? (
                  <p className="text-xs">Interruption confirmed for the listed work.</p>
                ) : null}
                <div className="mt-1 flex flex-wrap gap-2">
                  {presentation.canInterrupt && live ? (
                    <Button size="sm" variant="outline" onClick={() => void interrupt.open(live)}>
                      {live.consent === "recorded" ? "Review interruption" : "Interrupt and update"}
                    </Button>
                  ) : null}
                  {presentation.canCancel && live ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={model.busy}
                      onClick={() => void model.cancel(live)}
                    >
                      Cancel update
                    </Button>
                  ) : null}
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {model.statusError ? (
            <p role="status" className="text-xs text-warning">
              Status unavailable: {model.statusError} Retrying.
            </p>
          ) : null}
          <RemoteBackendUpdateInterruptDialog flow={interrupt} />
        </div>
      }
    />
  );
}
