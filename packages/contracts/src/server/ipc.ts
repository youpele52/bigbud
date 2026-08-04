import type { DesktopWindowMaterial } from "../core/settings";
import type { DesktopBackendStartupState } from "./ipc.desktop";
import type {
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
  DesktopRuntimePlatform,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from "./ipc.desktop";
import type { DesktopCertificateChallengeBridge } from "./ipc.desktopCertificate";
import type { DesktopComputerUseBridge } from "./ipc.desktopComputerUse";

export type {
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
  DesktopRuntimePlatform,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
  DesktopUpdateStatus,
} from "./ipc.desktop";
export * from "./ipc.desktopComputerUse";
export type { NativeApi } from "./ipc.nativeApi";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopNotificationInput {
  title: string;
  body?: string;
  silent?: boolean;
}

export interface DesktopTailscaleRemoteAccessStatus {
  installed: boolean;
  running: boolean;
  online: boolean;
  serving: boolean;
  remoteBaseUrl: string | null;
  error: string | null;
}

export interface DesktopBridge extends DesktopComputerUseBridge, DesktopCertificateChallengeBridge {
  getWsUrl: () => string | null;
  getMobileBackendBaseUrl: () => string | null;
  getBackendStartupState: () => Promise<DesktopBackendStartupState>;
  onBackendStartupState: (listener: (state: DesktopBackendStartupState) => void) => () => void;
  getTailscaleRemoteAccessStatus: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  enableTailscaleRemoteAccess: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  disableTailscaleRemoteAccess: () => Promise<DesktopTailscaleRemoteAccessStatus>;
  getFilePath: (file: File) => string;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  setWindowMaterial: (windowMaterial: DesktopWindowMaterial) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  notifications: {
    isSupported: () => Promise<boolean>;
    show: (input: DesktopNotificationInput) => Promise<boolean>;
  };
  copyToClipboard: (text: string) => Promise<void>;
  requestFileAccess: (
    level: "unrestricted" | "common-folders",
  ) => Promise<{ success: boolean; granted: string[]; denied: string[] }>;
}
