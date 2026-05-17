import { GITHUB_REPO_SLUG } from "./app";

const INSTALLER_BASE_URL =
  `https://raw.githubusercontent.com/${GITHUB_REPO_SLUG}/main/apps/marketing/public` as const;

export const INSTALL_COMMANDS = {
  unix: `curl -fsSL ${INSTALLER_BASE_URL}/install.sh | sh`,
  windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${INSTALLER_BASE_URL}/install.ps1 | iex"`,
} as const;

export const MACOS_QUARANTINE_COMMAND =
  `xattr -dr com.apple.quarantine "/Applications/bigbud (Beta).app"` as const;

export const DOWNLOAD_BUTTON_LABELS = {
  mac: "Download for macOS",
  win: "Download for Windows",
  linux: "Download for Linux",
} as const;

export const RELEASE_ASSET_SUFFIXES = {
  macArm64: "arm64.dmg",
  macX64: "x64.dmg",
  windowsX64: "x64.exe",
  linuxAppImage: "AppImage",
} as const;

export const COPY_SUCCESS_TEXT = "Copied";
export const DEFAULT_MAC_ARCH = "arm64" as const;
