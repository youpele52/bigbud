import { app, autoUpdater as electronAutoUpdater, BrowserWindow } from "electron";
import type { DesktopUpdateState } from "@bigbud/contracts";
import { autoUpdater } from "electron-updater";

import { formatErrorMessage } from "../logging/logging";
import { readAppUpdateYml } from "../env/pathResolver";
import { isArm64HostRunningIntelBuild } from "../env/runtimeArch";
import { getAutoUpdateDisabledReason, shouldBroadcastDownloadProgress } from "./updateState";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnInstallStart,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import type { DesktopRuntimeInfo } from "@bigbud/contracts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DESKTOP_UPDATE_CHANNEL = "latest";
const DESKTOP_UPDATE_ALLOW_PRERELEASE = false;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

export let updatePollTimer: ReturnType<typeof setInterval> | null = null;
export let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
export let updateCheckInFlight = false;
export let updateDownloadInFlight = false;
export let updateInstallInFlight = false;
export let updaterConfigured = false;

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

// ---------------------------------------------------------------------------
// Update state (initialised lazily so app.getVersion() works after ready)
// ---------------------------------------------------------------------------

let _updateState: DesktopUpdateState | null = null;
let _updateStateChannel = "";
let _desktopRuntimeInfo: DesktopRuntimeInfo | null = null;
let _isDevelopment = false;
let _getIsQuitting: (() => boolean) | null = null;
let _setIsQuitting: ((v: boolean) => void) | null = null;
let _stopBackendAndWaitForExit: (() => Promise<void>) | null = null;

/** The current auto-updater state (initialised after init()). */
export function getUpdateState(): DesktopUpdateState {
  if (!_updateState) throw new Error("autoUpdater module not initialised");
  return _updateState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (!_updateState) return null;
  if (updateInstallInFlight) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return _updateState.errorContext;
}

export function emitUpdateState(): void {
  if (!_updateState) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(_updateStateChannel, _updateState);
  }
}

export function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  if (!_updateState) return;
  _updateState = { ..._updateState, ...patch };
  emitUpdateState();
}

export function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

export function shouldEnableAutoUpdates(): boolean {
  return (
    getAutoUpdateDisabledReason({
      isDevelopment: _isDevelopment,
      isPackaged: app.isPackaged,
      platform: process.platform,
      appImage: process.env.APPIMAGE,
      disabledByEnv:
        (process.env.BIGBUD_DISABLE_AUTO_UPDATE ?? process.env.T3CODE_DISABLE_AUTO_UPDATE) === "1",
    }) === null
  );
}

// ---------------------------------------------------------------------------
// Core update actions
// ---------------------------------------------------------------------------

export async function checkForUpdates(reason: string): Promise<boolean> {
  if (!_updateState || !_getIsQuitting) return false;
  if (_getIsQuitting() || !updaterConfigured || updateCheckInFlight) return false;
  if (_updateState.status === "downloading" || _updateState.status === "downloaded") {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${_updateState.status}.`,
    );
    return false;
  }
  updateCheckInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(_updateState, new Date().toISOString()));
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(_updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
    return true;
  } finally {
    updateCheckInFlight = false;
  }
}

export async function downloadAvailableUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (!_updateState || !_desktopRuntimeInfo) return { accepted: false, completed: false };
  if (!updaterConfigured || updateDownloadInFlight || _updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(_updateState));
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(_desktopRuntimeInfo);
  console.info("[desktop-updater] Downloading update...");

  try {
    await autoUpdater.downloadUpdate();
    return { accepted: true, completed: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(_updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    updateDownloadInFlight = false;
  }
}

export async function installDownloadedUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (!_updateState || !_getIsQuitting || !_setIsQuitting || !_stopBackendAndWaitForExit) {
    return { accepted: false, completed: false };
  }
  if (_getIsQuitting() || !updaterConfigured || _updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }

  _setIsQuitting(true);
  updateInstallInFlight = true;
  clearUpdatePollTimer();
  // Transition to "installing" so the UI can show a "Restarting…" state immediately.
  setUpdateState(reduceDesktopUpdateStateOnInstallStart(_updateState));
  try {
    await _stopBackendAndWaitForExit();
    // Hand off to the platform updater.
    // - Windows (NSIS): quitAndInstall(isSilent, isForceRunAfter) — suppress UI and re-launch.
    // - macOS (Squirrel.Mac) / Linux (AppImage): quitAndInstall() — no arguments needed.
    // Do NOT manually destroy windows here: Electron's before-quit-for-update event fires
    // after quitAndInstall() is called and handles window teardown in the normal lifecycle.
    if (process.platform === "win32") {
      autoUpdater.quitAndInstall(true, true);
    } else {
      autoUpdater.quitAndInstall();
    }
    // The process should quit from here. Return accepted=true, completed=false because the
    // actual install completion is verified by the process exiting (or an updater error event).
    return { accepted: true, completed: false };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    updateInstallInFlight = false;
    _setIsQuitting(false);
    setUpdateState(reduceDesktopUpdateStateOnInstallFailure(_updateState, message));
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    return { accepted: true, completed: false };
  }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

export interface AutoUpdaterDeps {
  /** IPC channel name to push update state onto. */
  readonly updateStateChannel: string;
  readonly runtimeInfo: DesktopRuntimeInfo;
  readonly isDevelopment: boolean;
  readonly getIsQuitting: () => boolean;
  readonly setIsQuitting: (v: boolean) => void;
  readonly stopBackendAndWaitForExit: () => Promise<void>;
  /**
   * Called when `before-quit-for-update` fires on the Electron built-in
   * autoUpdater. Used by main.ts to run the same backend-stop / timer-clear
   * path as `before-quit`, since the two events are mutually exclusive.
   */
  readonly onBeforeQuitForUpdate: () => void;
}

export function configureAutoUpdater(deps: AutoUpdaterDeps): void {
  _updateStateChannel = deps.updateStateChannel;
  _desktopRuntimeInfo = deps.runtimeInfo;
  _isDevelopment = deps.isDevelopment;
  _getIsQuitting = deps.getIsQuitting;
  _setIsQuitting = deps.setIsQuitting;
  _stopBackendAndWaitForExit = deps.stopBackendAndWaitForExit;

  // Register cleanup on the Electron built-in autoUpdater. electron-updater's
  // quitAndInstall emits this event via require("electron").autoUpdater; it is
  // NOT emitted on app, so it must be wired here.
  electronAutoUpdater.on("before-quit-for-update", deps.onBeforeQuitForUpdate);

  // Initialise the state now that app.getVersion() is available.
  _updateState = createInitialDesktopUpdateState(app.getVersion(), deps.runtimeInfo);

  const enabled = shouldEnableAutoUpdates();
  _updateState = {
    ...createInitialDesktopUpdateState(app.getVersion(), deps.runtimeInfo),
    enabled,
    status: enabled ? "idle" : "disabled",
  };

  if (!enabled) {
    return;
  }
  updaterConfigured = true;

  const githubToken =
    process.env.BIGBUD_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() ||
    process.env.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    "";
  if (githubToken) {
    // When a token is provided, re-configure the feed with `private: true` so
    // electron-updater uses the GitHub API (api.github.com) instead of the
    // public Atom feed (github.com/…/releases.atom) which rejects Bearer auth.
    const appUpdateYml = readAppUpdateYml();
    if (appUpdateYml?.provider === "github") {
      autoUpdater.setFeedURL({
        ...appUpdateYml,
        provider: "github" as const,
        private: true,
        token: githubToken,
      });
    }
  }

  if (process.env.BIGBUD_DESKTOP_MOCK_UPDATES || process.env.T3CODE_DESKTOP_MOCK_UPDATES) {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: `http://localhost:${process.env.BIGBUD_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? process.env.T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? 3000}`,
    });
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Keep alpha branding, but force all installs onto the stable update track.
  autoUpdater.channel = DESKTOP_UPDATE_CHANNEL;
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = isArm64HostRunningIntelBuild(deps.runtimeInfo);
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(deps.runtimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    if (!_updateState) return;
    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        _updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    if (!_updateState) return;
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(_updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    if (!_updateState || !_getIsQuitting || !_setIsQuitting) return;
    const message = formatErrorMessage(error);
    if (updateInstallInFlight) {
      updateInstallInFlight = false;
      _setIsQuitting(false);
      setUpdateState(reduceDesktopUpdateStateOnInstallFailure(_updateState, message));
      console.error(`[desktop-updater] Updater error: ${message}`);
      return;
    }
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext: resolveUpdaterErrorContext(),
        canRetry: _updateState.availableVersion !== null || _updateState.downloadedVersion !== null,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
  });
  autoUpdater.on("download-progress", (progress) => {
    if (!_updateState) return;
    const percent = Math.floor(progress.percent);
    if (
      shouldBroadcastDownloadProgress(_updateState, progress.percent) ||
      _updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(_updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    if (!_updateState) return;
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(_updateState, info.version));
    console.info(`[desktop-updater] Update downloaded: ${info.version}`);
  });

  clearUpdatePollTimer();

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}
