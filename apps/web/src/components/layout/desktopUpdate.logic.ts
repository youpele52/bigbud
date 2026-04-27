import type { DesktopUpdateActionResult, DesktopUpdateState } from "@bigbud/contracts";

/**
 * "open-download" is returned for Linux non-AppImage builds where in-app install
 * is not available. The UI should open the releases page in a browser instead.
 */
export type DesktopUpdateButtonAction = "download" | "install" | "open-download" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.status === "installing") {
    return "none";
  }
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  // Disabled updater on Linux non-AppImage: surface a fallback CTA.
  if (!state.enabled && state.status === "disabled") {
    return "open-download";
  }
  return "none";
}

/** Unsigned builds cannot auto-install on macOS/Windows — manual install is required. */
export function isUnsignedBuildBlocked(state: DesktopUpdateState | null): boolean {
  if (!state) return false;
  if (state.isCodeSigned) return false;
  if (state.platform === "linux") return false;
  return state.status === "downloaded" || state.status === "installing";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state) {
    return false;
  }
  // Show the button for Linux non-AppImage fallback even when updater is disabled.
  if (!state.enabled && resolveDesktopUpdateButtonAction(state) === "open-download") {
    return true;
  }
  if (!state.enabled) {
    return false;
  }
  if (state.status === "downloading" || state.status === "installing") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading" || state?.status === "installing";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but bigbud is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but bigbud is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but bigbud is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    if (isUnsignedBuildBlocked(state)) {
      return `Update ${state.downloadedVersion ?? "ready"} downloaded. This unsigned build cannot auto-install. Go to Settings → About for manual install instructions.`;
    }
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "installing") {
    if (isUnsignedBuildBlocked(state)) {
      return "This unsigned build cannot auto-install updates. Go to Settings → About for manual install instructions.";
    }
    return "Installing update and restarting…";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    return state.message ?? "Update failed";
  }
  if (state.status === "disabled") {
    return "Open latest release";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install update${version ? ` ${version}` : ""} and restart bigbud?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded" &&
    state.status !== "installing" &&
    state.status !== "disabled"
  );
}
