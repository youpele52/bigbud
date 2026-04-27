import type {
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
  DesktopRuntimePlatform,
} from "@bigbud/contracts";
import {
  NODE_PLATFORM_DARWIN,
  NODE_PLATFORM_LINUX,
  NODE_PLATFORM_WIN32,
} from "@bigbud/shared/platform";
import * as ChildProcess from "node:child_process";
import { app } from "electron";

const PLATFORMS = {
  darwin: NODE_PLATFORM_DARWIN,
  linux: NODE_PLATFORM_LINUX,
  win32: NODE_PLATFORM_WIN32,
} as const;

interface ResolveDesktopRuntimeInfoInput {
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
}

function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "other";
}

function normalizeDesktopPlatform(platform: NodeJS.Platform): DesktopRuntimePlatform {
  if (platform === PLATFORMS.darwin) return NODE_PLATFORM_DARWIN;
  if (platform === PLATFORMS.linux) return NODE_PLATFORM_LINUX;
  if (platform === PLATFORMS.win32) return NODE_PLATFORM_WIN32;
  return "other";
}

/** Detect whether the packaged app binary has a valid code signature. */
export function resolveCodeSigned(): boolean {
  if (typeof app === "undefined" || !app.isPackaged) return false;

  if (process.platform === NODE_PLATFORM_DARWIN) {
    try {
      const appPath = app.getPath("exe");
      // codesign -dv prints info to stderr and exits 0 for signed, non-0 for unsigned.
      ChildProcess.execFileSync("codesign", ["-dv", appPath], {
        stdio: "ignore",
        timeout: 3_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  if (process.platform === NODE_PLATFORM_WIN32) {
    try {
      const appPath = app.getPath("exe");
      // signtool verify exits 0 for signed, non-0 for unsigned.
      ChildProcess.execFileSync("signtool", ["verify", "/pa", appPath], {
        stdio: "ignore",
        timeout: 3_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  // Linux (AppImage) — no standard signature format; treat as unsigned.
  return false;
}

export function resolveDesktopRuntimeInfo(
  input: ResolveDesktopRuntimeInfoInput,
): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch);
  const platform = normalizeDesktopPlatform(input.platform);

  if (input.platform !== NODE_PLATFORM_DARWIN) {
    return {
      platform,
      hostArch: appArch,
      appArch,
      runningUnderArm64Translation: false,
      isCodeSigned: resolveCodeSigned(),
    };
  }

  const hostArch = appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch;

  return {
    platform,
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
    isCodeSigned: resolveCodeSigned(),
  };
}

export function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}
