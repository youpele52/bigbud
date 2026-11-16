import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";

/**
 * - `pass` / `fail`: checked on this computer.
 * - `skipped`: not checked because an earlier step failed.
 * - `phone`: only checkable on the phone itself.
 */
export type TailscaleDoctorStepState = "pass" | "fail" | "skipped" | "phone";

export interface TailscaleDoctorStep {
  readonly id: "installed" | "running" | "online" | "name" | "serve" | "phone";
  readonly label: string;
  readonly state: TailscaleDoctorStepState;
  readonly detail: string | null;
}

interface HostCheck {
  readonly id: Exclude<TailscaleDoctorStep["id"], "phone">;
  readonly label: string;
  readonly passed: (status: DesktopTailscaleRemoteAccessStatus) => boolean;
  readonly failureDetail: (status: DesktopTailscaleRemoteAccessStatus) => string;
}

const HOST_CHECKS: ReadonlyArray<HostCheck> = [
  {
    id: "installed",
    label: "Tailscale is installed on this computer",
    passed: (status) => status.installed,
    failureDetail: () => "Install Tailscale and sign in to your tailnet.",
  },
  {
    id: "running",
    label: "Tailscale is running",
    passed: (status) => status.running,
    failureDetail: () => "Start Tailscale on this computer.",
  },
  {
    id: "online",
    label: "This computer is online in your tailnet",
    passed: (status) => status.online,
    failureDetail: () => "Reconnect this computer to your tailnet.",
  },
  {
    id: "name",
    label: "This computer has a tailnet name",
    passed: (status) => status.remoteBaseUrl !== null,
    failureDetail: () => "Turn on MagicDNS for your tailnet in the Tailscale admin console.",
  },
  {
    id: "serve",
    label: "Tailscale Serve sends HTTPS to this desktop backend",
    passed: (status) => status.serving,
    failureDetail: (status) =>
      status.error ?? "Enable Tailscale Serve above, then create a new pairing link.",
  },
];

const PHONE_STEP: TailscaleDoctorStep = {
  id: "phone",
  label: "The phone has Tailscale signed in and connected",
  state: "phone",
  detail:
    "Check this on the phone. Your tailnet's access rules must also let the phone reach this computer.",
};

/**
 * Staged host-side checks for reaching this desktop from another network.
 * Steps after the first failure are marked skipped rather than guessed. A full
 * pass is local configuration evidence only; it cannot prove the phone connects.
 */
export function resolveTailscaleDoctorSteps(
  status: DesktopTailscaleRemoteAccessStatus,
): ReadonlyArray<TailscaleDoctorStep> {
  let failed = false;
  const hostSteps = HOST_CHECKS.map((check): TailscaleDoctorStep => {
    if (failed) return { id: check.id, label: check.label, state: "skipped", detail: null };
    if (check.passed(status)) {
      const detail = check.id === "name" ? status.remoteBaseUrl : null;
      return { id: check.id, label: check.label, state: "pass", detail };
    }
    failed = true;
    return { id: check.id, label: check.label, state: "fail", detail: check.failureDetail(status) };
  });
  return [...hostSteps, PHONE_STEP];
}
