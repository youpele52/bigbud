import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";
import { CheckIcon, MinusIcon, SmartphoneIcon, XIcon } from "lucide-react";

import {
  resolveTailscaleDoctorSteps,
  type TailscaleDoctorStepState,
} from "./MobileRemoteControlSettingsSection.doctor.logic";

const STATE_ICON = {
  pass: { Icon: CheckIcon, className: "text-emerald-600 dark:text-emerald-400", label: "Passed" },
  fail: { Icon: XIcon, className: "text-destructive", label: "Failed" },
  skipped: { Icon: MinusIcon, className: "text-muted-foreground", label: "Not checked" },
  phone: { Icon: SmartphoneIcon, className: "text-muted-foreground", label: "Check on phone" },
} satisfies Record<TailscaleDoctorStepState, unknown>;

/** Staged connection checklist for reaching this desktop from another network. */
export function MobileRemoteTailscaleDoctor({
  status,
}: {
  readonly status: DesktopTailscaleRemoteAccessStatus;
}) {
  return (
    <ol className="space-y-1.5" aria-label="Remote access checks" data-testid="tailscale-doctor">
      {resolveTailscaleDoctorSteps(status).map((step) => {
        const { Icon, className, label } = STATE_ICON[step.state];
        return (
          <li key={step.id} className="flex gap-2 text-xs" data-state={step.state}>
            <Icon aria-label={label} className={`mt-0.5 size-3.5 shrink-0 ${className}`} />
            <div className="min-w-0">
              <p className={step.state === "skipped" ? "text-muted-foreground" : "text-foreground"}>
                {step.label}
              </p>
              {step.detail ? (
                <p className="break-all text-muted-foreground">{step.detail}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
