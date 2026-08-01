import { startCuaDriverDaemon } from "./cuaDriver.daemon";

const CUA_DAEMON_BACKEND_START_BUDGET_MS = 12_000;

export async function resolveComputerUseRuntimeEnv(
  baseDir: string,
  hostBundleId: string,
): Promise<NodeJS.ProcessEnv> {
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
