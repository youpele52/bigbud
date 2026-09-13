import { realpath } from "node:fs/promises";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

import { createDevPortCoordinator } from "@bigbud/shared/DevPortCoordinator";

import { isWebDevInformationRequest, webDevStartPort, webDevViteArgs } from "./dev.options.ts";
import { reserveWebDevPort } from "./dev.ports.ts";

export async function runWebDev(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cli = new URL("./bin/vite.js", import.meta.resolve("vite/package.json"));
  let viteArgs = [...args];
  const shutdown = new AbortController();
  const onInterrupt = () => shutdown.abort("SIGINT");
  const onTerminate = () => shutdown.abort("SIGTERM");
  const onHangup = () => shutdown.abort("SIGHUP");
  const onQuit = () => shutdown.abort("SIGQUIT");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("SIGHUP", onHangup);
  process.on("SIGQUIT", onQuit);
  let lease: Awaited<ReturnType<typeof reserveWebDevPort>> | undefined;
  try {
    if (!isWebDevInformationRequest(args)) {
      // Identity is anchored to this checkout, independent of cwd and user state.
      const repoRoot = await realpath(fileURLToPath(new URL("../..", import.meta.url)));
      const coordinator = await createDevPortCoordinator(repoRoot);
      lease = await reserveWebDevPort(
        coordinator,
        webDevStartPort(args, process.env),
        process.env.BIGBUD_DEV_WEB_RESERVATION,
        shutdown.signal,
      );
      const port = lease.reservation.port;
      viteArgs = webDevViteArgs(args, port);
      process.env.PORT = String(port);
      process.env.BIGBUD_DEV_REPO_ROOT = repoRoot;
    }
    shutdown.signal.throwIfAborted();
  } catch (error) {
    await lease?.release();
    if (shutdown.signal.aborted) {
      process.exitCode = 128 + constants.signals[shutdown.signal.reason as NodeJS.Signals];
      return;
    }
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.off("SIGHUP", onHangup);
    process.off("SIGQUIT", onQuit);
  }

  // The actual Vite listener and its lease have the same PID. There is no
  // supervisor/child ownership gap, including during startup and SIGKILL.
  // Import completion is NOT server completion: Vite starts asynchronously.
  // Keep the lease until process death; the coordinator then reclaims it.
  // Never release on beforeExit, which can recur or be followed by new work.
  process.argv = [process.execPath, fileURLToPath(cli), ...viteArgs];
  await import(cli.href);
}

if (import.meta.main) {
  try {
    await runWebDev();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
