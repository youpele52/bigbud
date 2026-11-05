import { Button } from "../ui/button";
import type {
  AppliedStateCopy,
  SupervisedNativeState,
} from "./ComputerUseSupervisedSettings.logic";
import { ComputerUseSupervisedStatusText } from "./ComputerUseSupervisedStatusText";
import { SettingsRow } from "./settingsLayout";

function describeNative(native: SupervisedNativeState | null): AppliedStateCopy {
  if (!native || native.kind === "unavailable") {
    return { tone: "warning", text: "Status unavailable: native control is not connected." };
  }
  if (native.latched) return { tone: "error", text: "Stopped. Resume is required to continue." };
  if (native.health === "ready") return { tone: "success", text: "Ready." };
  return { tone: "warning", text: native.health === "paused" ? "Paused." : "Degraded." };
}

/**
 * Stop/Resume status. Not an enablement preference: Stop has no confirmation
 * delay; Resume needs a current owner-issued challenge and cannot enable a
 * disabled feature or waive any restriction.
 */
export function ComputerUseSafetyStatusRow({
  native,
  canStop,
  pending,
  onStop,
  onResume,
}: {
  native: SupervisedNativeState | null;
  canStop: boolean;
  pending: boolean;
  onStop: () => void;
  onResume: (challenge: string) => void;
}) {
  const challenge = native?.kind === "connected" && native.latched ? native.resumeChallenge : null;
  return (
    <SettingsRow
      title="Stop and resume"
      description="Stop ends all desktop automation immediately and stays in effect until you resume."
      status={<ComputerUseSupervisedStatusText copy={describeNative(native)} />}
      control={
        <>
          <Button size="xs" variant="destructive" disabled={!canStop} onClick={onStop}>
            Stop
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={pending || challenge === null}
            onClick={() => {
              if (challenge !== null) onResume(challenge);
            }}
          >
            Resume
          </Button>
        </>
      }
    />
  );
}
