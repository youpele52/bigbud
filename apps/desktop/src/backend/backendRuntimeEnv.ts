import {
  type ComputerUseContractProfile,
  selectedComputerUseContractProfile,
} from "@bigbud/shared/computer-use/selection";

import { startCuaDriverDaemon } from "./cuaDriver.daemon";

const CUA_DAEMON_BACKEND_START_BUDGET_MS = 12_000;

/**
 * Starts the TypeScript-managed Cua daemon (Driver 0.9.1 or 0.38.0) for the backend and returns
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      startCuaDriverDaemon(baseDir, hostBundleId).catch((error) => {
        console.error(
          `[desktop] cua-driver startup failed; continuing without it: ${String(error)}`,
        );
        return {};
      }),
      new Promise<NodeJS.ProcessEnv>((resolve) => {
        timer = setTimeout(() => {
          console.error("[desktop] cua-driver startup timed out; continuing without it");
          resolve({});
        }, CUA_DAEMON_BACKEND_START_BUDGET_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
