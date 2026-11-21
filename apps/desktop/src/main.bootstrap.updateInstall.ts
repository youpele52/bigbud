import { preservePackagedCopilotRuntime } from "./backend/copilotRuntimeMigration";
import { stopBackendAndWaitForExit } from "./backend/backendManager";
import { resolveComputerUseRuntime } from "./backend/cuaDriver.runtime";
import { stopCuaDriverDaemonAndWait } from "./backend/cuaDriver.daemon";
import { stopCuaDriverCommandsAndWait } from "./backend/cuaDriver.process";
import { sweepWindowsCuaDriverProcesses } from "./backend/cuaDriver.windowsSweep";
import {
  beginInstalledProcessQuiescence,
  getInstalledProcessTreeUncertainty,
} from "./backend/installedProcessQuiescence";
import { assertWindowsFilesReplaceable } from "./backend/windowsFileReplaceability";
import type { DesktopQuitTeardown } from "./main.quitTeardown";
import { RestartRequiredUpdatePreparationError } from "./updater/autoUpdater.install";
import { resolveWindowsUpdateTargets } from "./updater/windowsUpdateTargets";

interface PrepareForUpdateInstallOptions {
  /** Legacy Cua runtime base (`cuaDriverBaseDir` in main config). */
  readonly cuaDriverBaseDir: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runQuitHandshake: DesktopQuitTeardown["runHandshake"];
}

/**
 * Quiesces every installed process before the updater replaces the app. The quit handshake
 * runs first, with reason `update`, while the backend still runs: the server records the intent
 * before it is stopped, and the handshake is marked done before `quitAndInstall`, so the
 * updater's own `before-quit` is never prevented (F7).
 */
export function createPrepareForUpdateInstall(
  options: PrepareForUpdateInstallOptions,
): () => Promise<void> {
  const { cuaDriverBaseDir, isPackaged, resourcesPath, runQuitHandshake } = options;
  return async () => {
    await preservePackagedCopilotRuntime(isPackaged, resourcesPath);
    beginInstalledProcessQuiescence();
    const errors: unknown[] = [];
    let sweepError: unknown = null;
    // An unacknowledged or failed handshake only means the server detaches; never block on it.
    await runQuitHandshake("update").catch((error: unknown) => {
      console.error("[desktop-updater] Quit handshake failed before install.", error);
    });
    try {
      await stopBackendAndWaitForExit();
    } catch (error: unknown) {
      errors.push(error);
      console.error("[desktop-updater] Backend cleanup failed before install.", error);
    }
    try {
      await stopCuaDriverDaemonAndWait();
    } catch (error: unknown) {
      errors.push(error);
      console.error("[desktop-updater] CUA daemon cleanup failed before install.", error);
    }
    try {
      await stopCuaDriverCommandsAndWait();
    } catch (error: unknown) {
      errors.push(error);
      console.error("[desktop-updater] CUA command cleanup failed before install.", error);
    }
    if (process.platform === "win32") {
      const cuaDriverPath = resolveComputerUseRuntime(cuaDriverBaseDir).binaryPath;
      try {
        sweepWindowsCuaDriverProcesses({
          executablePath: cuaDriverPath,
        });
      } catch (error: unknown) {
        sweepError = error;
        errors.push(error);
        console.error("[desktop-updater] Windows CUA process sweep failed before install.", error);
      }
      try {
        assertWindowsFilesReplaceable({
          targets: resolveWindowsUpdateTargets({
            cuaDriverPath,
            isPackaged,
            platform: process.platform,
            resourcesPath,
          }),
        });
      } catch (error: unknown) {
        errors.push(error);
        console.error("[desktop-updater] Windows runtime lock probe failed before install.", error);
      }
    }
    const uncertainty = getInstalledProcessTreeUncertainty();
    if (uncertainty) {
      throw new RestartRequiredUpdatePreparationError(uncertainty.message);
    }
    if (sweepError) {
      const message = sweepError instanceof Error ? sweepError.message : String(sweepError);
      throw new RestartRequiredUpdatePreparationError(message);
    }
    if (errors.length > 0) {
      const details = errors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join("; ");
      throw new AggregateError(errors, `Pre-install process cleanup failed: ${details}`);
    }
  };
}
