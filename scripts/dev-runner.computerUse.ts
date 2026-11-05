import {
  resolveSupervisedExecutionGate,
  selectedComputerUseContractProfile,
  type ComputerUseContractProfile,
} from "@bigbud/shared/computer-use/selection";

import type { DevMode } from "./dev-runner.lib.ts";

/** Debug build of the supervised computer-use guard (`target/debug`). */
export const COMPUTER_USE_GUARD_BUILD_ARGS = [
  "build",
  "--locked",
  "--package",
  "bigbud-computer-use",
  "--bin",
  "bigbud-computer-use",
] as const;

/**
 * True only when `dev:desktop` on macOS will start the guard: the same
 * selection gate as the desktop app (closed while Driver 0.9.1 is pinned, and
 * after the switch only with `BIGBUD_COMPUTER_USE_SUPERVISED_DEV=1`).
 */
export function devModeRequiresComputerUseGuard(
  mode: DevMode,
  env: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
  arch: string = process.arch,
  profile: ComputerUseContractProfile = selectedComputerUseContractProfile,
): boolean {
  if (mode !== "dev:desktop" || platform !== "darwin") return false;
  return resolveSupervisedExecutionGate({ profile, platform, arch, development: true, env }).open;
}
