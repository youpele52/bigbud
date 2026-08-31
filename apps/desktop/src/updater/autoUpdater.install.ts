export interface UpdateInstallResult {
  readonly accepted: boolean;
  readonly completed: boolean;
}

export class RestartRequiredUpdatePreparationError extends Error {
  override readonly name = "RestartRequiredUpdatePreparationError";
}

export interface UpdateInstallCoordinatorDeps {
  readonly beginUpdatePreparation: () => void;
  readonly canInstall: () => boolean;
  readonly clearUpdateTimers: () => void;
  readonly formatError: (error: unknown) => string;
  readonly getIsQuitting: () => boolean;
  readonly onHandoffFailure: (message: string) => void;
  readonly onInstallStart: () => void;
  readonly onRestartRequiredPreparationFailure: (message: string) => void;
  readonly platform: NodeJS.Platform;
  readonly prepareForUpdateInstall: () => Promise<void>;
  readonly quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  readonly setIsQuitting: (value: boolean) => void;
}

export interface UpdateInstallCoordinator {
  readonly handleUpdaterError: (error: unknown) => boolean;
  readonly install: () => Promise<UpdateInstallResult>;
  readonly isInFlight: () => boolean;
  readonly markHandoffAccepted: () => void;
}

const INSTALL_HANDOFF_TIMEOUT_MS = 5_000;
const INSTALL_HANDOFF_FAILURE_MESSAGE =
  "The updater did not complete the restart. Restart bigbud before trying to install again.";
const RESTART_AFTER_HANDOFF_FAILURE = "Restart bigbud before trying to install again.";

export function handleUpdateHandoffAccepted(
  coordinator: Pick<UpdateInstallCoordinator, "markHandoffAccepted">,
  onBeforeQuitForUpdate: () => void,
): void {
  coordinator.markHandoffAccepted();
  onBeforeQuitForUpdate();
}

export function createUpdateInstallCoordinator(
  deps: UpdateInstallCoordinatorDeps,
): UpdateInstallCoordinator {
  let installPromise: Promise<UpdateInstallResult> | null = null;
  let handoffPending = false;
  let handoffInvoked = false;
  let handoffAccepted = false;
  let preparationError: string | null = null;
  let preparing = false;
  let restartRequired = false;
  let handoffTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearHandoffTimeout = () => {
    if (!handoffTimeout) return;
    clearTimeout(handoffTimeout);
    handoffTimeout = null;
  };

  const failHandoff = (message: string) => {
    clearHandoffTimeout();
    handoffPending = false;
    restartRequired = true;
    const finalMessage = message.includes(RESTART_AFTER_HANDOFF_FAILURE)
      ? message
      : `${message} ${RESTART_AFTER_HANDOFF_FAILURE}`;
    deps.onHandoffFailure(finalMessage);
    console.error(`[desktop-updater] Failed to install update: ${finalMessage}`);
  };

  const runInstall = async (): Promise<UpdateInstallResult> => {
    try {
      restartRequired = true;
      deps.beginUpdatePreparation();
      preparing = true;
      handoffInvoked = false;
      preparationError = null;
      console.info("[desktop-updater] Preparing processes for update installation...");
      await deps.prepareForUpdateInstall();
      preparing = false;
      if (preparationError) throw new Error(preparationError);
      if (deps.getIsQuitting()) {
        console.info("[desktop-updater] Skipping updater handoff because app quit is in progress.");
        return { accepted: true, completed: false };
      }
      if (!deps.canInstall()) {
        throw new Error("The downloaded update is no longer eligible for installation.");
      }

      deps.clearUpdateTimers();
      deps.setIsQuitting(true);
      deps.onInstallStart();
      handoffPending = true;
      handoffInvoked = true;
      console.info(
        `[desktop-updater] Process cleanup complete; handing off to ${deps.platform} updater.`,
      );
      if (deps.platform === "win32") deps.quitAndInstall(true, true);
      else deps.quitAndInstall();

      if (deps.platform !== "darwin" && handoffPending) {
        handoffTimeout = setTimeout(() => {
          handoffTimeout = null;
          if (handoffPending) failHandoff(INSTALL_HANDOFF_FAILURE_MESSAGE);
        }, INSTALL_HANDOFF_TIMEOUT_MS);
        handoffTimeout.unref();
      }
      return { accepted: true, completed: false };
    } catch (error: unknown) {
      preparing = false;
      clearHandoffTimeout();
      handoffPending = false;
      const message = deps.formatError(error);
      if (handoffInvoked) {
        failHandoff(message);
      } else {
        const finalMessage = message.includes(RESTART_AFTER_HANDOFF_FAILURE)
          ? message
          : `${message} ${RESTART_AFTER_HANDOFF_FAILURE}`;
        deps.onRestartRequiredPreparationFailure(finalMessage);
        console.error(`[desktop-updater] Update preparation requires restart: ${finalMessage}`);
      }
      return { accepted: true, completed: false };
    }
  };

  return {
    install: () => {
      if (
        installPromise ||
        handoffPending ||
        handoffAccepted ||
        restartRequired ||
        deps.getIsQuitting() ||
        !deps.canInstall()
      ) {
        return Promise.resolve({ accepted: false, completed: false });
      }
      const request = runInstall();
      installPromise = request;
      const clearRequest = () => {
        if (installPromise === request) installPromise = null;
      };
      void request.then(clearRequest, clearRequest);
      return request;
    },
    isInFlight: () => installPromise !== null || handoffPending,
    markHandoffAccepted: () => {
      if (!handoffInvoked) return;
      clearHandoffTimeout();
      handoffPending = false;
      handoffAccepted = true;
    },
    handleUpdaterError: (error) => {
      const message = deps.formatError(error);
      if (preparing) {
        preparationError = message;
        return true;
      }
      if (handoffPending) {
        failHandoff(message);
        return true;
      }
      if (handoffInvoked) return true;
      return false;
    },
  };
}
