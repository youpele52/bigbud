import {
  type ComputerUseContractProfile,
  selectedComputerUseContractProfile,
} from "@bigbud/shared/computer-use/selection";

import { startCuaDriverDaemon } from "./cuaDriver.daemon";

/**
 * Starts the TypeScript-managed compatible Cua daemon for the backend and returns
 * its env. Only under the `legacy` contract profile, which no Driver pin changes: a supervised
 * `v2` profile (explicit cutover only) never starts this runtime and the backend gets no legacy
 * env (v2 fails closed; it never falls back to legacy). `profile` is injectable for tests;
 * production uses the constant selection.
 */
export async function resolveComputerUseRuntimeEnv(
  baseDir: string,
  hostBundleId: string,
  profile: ComputerUseContractProfile = selectedComputerUseContractProfile,
): Promise<NodeJS.ProcessEnv> {
  if (profile !== "legacy") {
    console.info(`[desktop] legacy cua-driver not started: ${profile} profile selected`);
    return {};
  }
  try {
    // Startup owns bounded preflight/readiness. Racing it here used to orphan a
    // successful late daemon after the backend had already received an empty env.
    return await startCuaDriverDaemon(baseDir, hostBundleId);
  } catch (error) {
    console.error(`[desktop] cua-driver startup failed; continuing without it: ${String(error)}`);
    return {};
  }
}
