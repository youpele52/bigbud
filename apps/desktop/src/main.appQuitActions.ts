import {
  DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE,
  DEV_APP_FATAL_EXIT_CODE,
  DEV_APP_RESTART_EXIT_CODE,
} from "@bigbud/shared/DevLauncher";
import type { App } from "electron";

export interface AppQuitActions {
  /** User-initiated Quit. Exit 0, which ends the dev session under the dev launcher. */
  readonly quit: (reason: string) => void;
  readonly restart: (reason: string) => void;
  /** After a fatal startup error or uncaught exception; the caller has already torn down. */
  readonly quitAfterFatalError: () => void;
  /** Another instance holds the single-instance lock. */
  readonly quitDuplicateInstance: () => void;
}

interface CreateAppQuitActionsOptions {
  readonly appInstance: Pick<App, "exit" | "once" | "quit" | "relaunch">;
  /** True only under the dev launcher (`VITE_DEV_SERVER_URL` is set). */
  readonly isDevelopment: boolean;
  readonly prepareForAppQuit: (reason: string) => void;
}

/**
 * Quit and Restart paths. Packaged builds behave exactly as before (`app.quit()`, and
 * `app.relaunch()` for Restart). Under the dev launcher (apps/desktop/scripts/dev-electron.mjs)
 * the exit code tells it what happened, because exit 0 means "the user quit; end the session".
 */
export function createAppQuitActions(options: CreateAppQuitActionsOptions): AppQuitActions {
  const { appInstance, isDevelopment, prepareForAppQuit } = options;
  /** Quit normally (before-quit teardown runs), then exit with `devExitCode` in development. */
  const quitWithDevExitCode = (devExitCode: number) => {
    if (isDevelopment) {
      // Emitted before and after `ready`, so this also covers quits during startup.
      appInstance.once("will-quit", (event) => {
        event.preventDefault();
        appInstance.exit(devExitCode);
      });
    }
    appInstance.quit();
  };
  return {
    quit(reason) {
      prepareForAppQuit(reason);
      appInstance.quit();
    },
    restart(reason) {
      if (isDevelopment) {
        // `app.relaunch()` would start a second app outside the dev launcher's supervision.
        prepareForAppQuit(reason);
        quitWithDevExitCode(DEV_APP_RESTART_EXIT_CODE);
        return;
      }
      appInstance.relaunch();
      prepareForAppQuit(reason);
      appInstance.quit();
    },
    quitAfterFatalError: () => quitWithDevExitCode(DEV_APP_FATAL_EXIT_CODE),
    quitDuplicateInstance: () => quitWithDevExitCode(DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE),
  };
}
