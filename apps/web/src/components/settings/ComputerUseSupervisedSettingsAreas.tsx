import { useCallback, useMemo, useState } from "react";

import { toastManager } from "../ui/toast";
import { ComputerUseAppRestrictionsRow } from "./ComputerUseAppRestrictionsRow";
import { ComputerUseDeliveryPreferenceRow } from "./ComputerUseDeliveryPreferenceRow";
import { ComputerUseDiagnosticsRow } from "./ComputerUseDiagnosticsRow";
import { ComputerUseSafetyStatusRow } from "./ComputerUseSafetyStatusRow";
import {
  canEditPolicy,
  createPendingTracker,
  editPolicyBody,
  withoutSelector,
  type PolicyEdit,
  type SupervisedSettingsPort,
  type SupervisedSettingsView,
} from "./ComputerUseSupervisedSettings.logic";

const NOT_CONNECTED: SupervisedSettingsView = { kind: "not-connected" };

/** The supervised settings areas; every change is awaited, never optimistic. */
export function ComputerUseSupervisedSettingsAreas({
  port,
}: {
  port: SupervisedSettingsPort | null;
}) {
  const view = port?.view ?? NOT_CONNECTED;
  const [pendingCount, setPendingCount] = useState(0);
  const track = useMemo(() => createPendingTracker(setPendingCount), []);
  const pending = pendingCount > 0;
  const run = useCallback(
    (failureTitle: string, operation: () => Promise<void>) =>
      track(operation).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: failureTitle,
          description: error instanceof Error ? error.message : undefined,
        });
      }),
    [track],
  );

  const desired = view.kind === "ready" ? view.desired : null;
  const editable = canEditPolicy(view, pending);
  const apply = (edit: PolicyEdit) => {
    if (!port || !desired || !editable) return;
    void run("Computer Use settings were not saved", () =>
      port.applyPolicy(editPolicyBody(desired, edit)),
    );
  };
  const native = view.kind === "ready" ? view.native : null;

  return (
    <>
      <ComputerUseSafetyStatusRow
        native={native}
        // Stop is never blocked by a pending settings change.
        canStop={port !== null}
        pending={pending}
        onStop={() => {
          if (port) void run("Computer Use could not be stopped", port.stop);
        }}
        onResume={(challenge) => {
          if (port) void run("Computer Use could not resume", () => port.resume(challenge));
        }}
      />
      <ComputerUseAppRestrictionsRow
        view={view}
        disabled={!editable}
        onRestore={(selector) =>
          desired && apply({ disallowedApps: withoutSelector(desired.disallowedApps, selector) })
        }
      />
      <ComputerUseDeliveryPreferenceRow
        value={desired?.defaultDeliveryMode ?? "foreground"}
        disabled={!editable}
        onChange={(defaultDeliveryMode) => apply({ defaultDeliveryMode })}
      />
      <ComputerUseDiagnosticsRow
        checked={desired?.diagnosticMetadataEnabled ?? false}
        disabled={!editable}
        onChange={(diagnosticMetadataEnabled) => apply({ diagnosticMetadataEnabled })}
      />
    </>
  );
}
