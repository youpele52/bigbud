import * as Path from "node:path";

import {
  resolveSupervisedExecutionGate,
  selectedComputerUseContractProfile,
  type ComputerUseContractProfile,
  type SupervisedExecutionGate,
} from "@bigbud/shared/computer-use/selection";

/**
 * Supervised computer-use guard lifecycle, pure decisions (plan M1: Electron
 * starts the guard). Exit statuses mirror
 * `crates/bigbud-computer-use/src/roles/guard.rs`; the guard role exists only
 * in debug (local development) builds until the M6 switch.
 */
export const GUARD_EXIT = {
  settled: 0,
  usage: 2,
  storage: 3,
  conflict: 4,
  recovery: 5,
  unsettled: 6,
} as const;

export type GuardExitReason =
  | "settled"
  | "usage"
  | "storage"
  | "conflict"
  | "recovery"
  | "unsettled"
  | "killed"
  | "spawn-failed"
  | "unknown";

export function guardExitReason(code: number | null, signal: string | null): GuardExitReason {
  if (signal !== null) return "killed";
  for (const [reason, value] of Object.entries(GUARD_EXIT)) {
    if (value === code) return reason as GuardExitReason;
  }
  return "unknown";
}

export type GuardLaunchPlan =
  | { readonly start: true; readonly binaryPath: string; readonly args: ReadonlyArray<string> }
  | {
      readonly start: false;
      readonly reason: Extract<SupervisedExecutionGate, { open: false }>["reason"] | "packaged";
    };

export interface GuardLaunchInput {
  readonly profile?: ComputerUseContractProfile;
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Repository root in development. */
  readonly rootDir: string;
  /** `<BIGBUD_HOME>/dev/computer-use` in development, `null` when packaged. */
  readonly developmentRoot: string | null;
}

/** Only the local dev app on macOS can start the guard before the switch. */
export function resolveGuardLaunchPlan(input: GuardLaunchInput): GuardLaunchPlan {
  const gate = resolveSupervisedExecutionGate({
    profile: input.profile ?? selectedComputerUseContractProfile,
    platform: input.platform,
    arch: input.arch,
    development: input.isDevelopment && !input.isPackaged,
    env: input.env,
  });
  if (!gate.open) return { start: false, reason: gate.reason };
  // Packaged staging/signing of the guard (M6.4) does not exist yet.
  if (input.isPackaged || input.developmentRoot === null || input.platform !== "darwin") {
    return { start: false, reason: "packaged" };
  }
  return {
    start: true,
    binaryPath: Path.join(input.rootDir, "target", "debug", "bigbud-computer-use"),
    args: ["guard", "--development-root", input.developmentRoot],
  };
}
