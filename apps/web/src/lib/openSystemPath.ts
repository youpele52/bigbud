import type { DesktopBridge } from "@bigbud/contracts";
import type {
  DesktopShellPathRefusalReason,
  DesktopShellPathResult,
} from "@bigbud/contracts/server/ipc.desktopShellPath.ts";
import { isAbsolutePath } from "@bigbud/shared/path";

import { isMarkdownFilePath } from "../components/files/FilePreview.logic";
import {
  isHtmlFilePath,
  isImageFilePath,
  isKnownBinaryFilePath,
  isPdfFilePath,
  isVideoFilePath,
} from "./workspaceFilePreview";

/**
 * Where bigbud can display a file itself, mirroring the existing panel routing: the Browser
 * panel takes PDF, HTML and images (checked first, like `openPathFromChat`); the Files panel
 * takes video, notebooks, Markdown and any other text or code. `null` means use the system app.
 */
export type InAppViewer =
  | { readonly panel: "browser"; readonly format: "pdf" | "html" | "image" }
  | { readonly panel: "files"; readonly format: "video" | "notebook" | "markdown" | "text" };

export function inAppViewerFor(path: string): InAppViewer | null {
  if (isPdfFilePath(path)) return { panel: "browser", format: "pdf" };
  if (isHtmlFilePath(path)) return { panel: "browser", format: "html" };
  if (isImageFilePath(path)) return { panel: "browser", format: "image" };
  if (isVideoFilePath(path)) return { panel: "files", format: "video" };
  if (isKnownBinaryFilePath(path)) return null;
  if (path.toLowerCase().endsWith(".ipynb")) return { panel: "files", format: "notebook" };
  if (isMarkdownFilePath(path)) return { panel: "files", format: "markdown" };
  return { panel: "files", format: "text" };
}

export type SystemPathRefusalReason =
  | DesktopShellPathRefusalReason
  /** The desktop shell denied this window (only the main window may open host files). */
  | "unauthorized";

/** Outcome of {@link openWithSystemDefault} and {@link revealInFileManager}. */
export type SystemPathOpenResult =
  | { readonly kind: "opened" }
  | { readonly kind: "revealed" }
  /** Open was requested, but the path would run or install, so it was only revealed. */
  | { readonly kind: "revealed-instead"; readonly reason: "launchable" }
  /** No desktop bridge: a browser or mobile client must not open apps on the host. */
  | { readonly kind: "unavailable-in-browser" }
  | {
      readonly kind: "refused";
      readonly reason: SystemPathRefusalReason;
      readonly message?: string;
    };

type ShellPathBridge = Pick<DesktopBridge, "openPath" | "showItemInFolder">;
type ShellPathAction = keyof ShellPathBridge;

function readShellPathBridge(): ShellPathBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

function toOpenResult(
  action: ShellPathAction,
  result: DesktopShellPathResult | null | undefined,
): SystemPathOpenResult {
  if (result?.status === "opened") return { kind: "opened" };
  if (result?.status === "revealed") {
    return action === "openPath" && result.launchable
      ? { kind: "revealed-instead", reason: "launchable" }
      : { kind: "revealed" };
  }
  if (result?.status === "refused") {
    return result.message === undefined
      ? { kind: "refused", reason: result.reason }
      : { kind: "refused", reason: result.reason, message: result.message };
  }
  return { kind: "refused", reason: "unauthorized" };
}

async function runShellPathAction(
  action: ShellPathAction,
  absolutePath: string,
  bridge: ShellPathBridge | undefined,
): Promise<SystemPathOpenResult> {
  const invoke = bridge?.[action];
  if (!invoke) return { kind: "unavailable-in-browser" };
  // The desktop shell validates again; this only avoids a round trip for obvious mistakes.
  if (!isAbsolutePath(absolutePath)) return { kind: "refused", reason: "invalid-path" };
  try {
    return toOpenResult(action, await invoke(absolutePath));
  } catch (error) {
    return {
      kind: "refused",
      reason: "open-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Opens a local absolute path in its default app through the desktop shell. Executables, scripts,
 * installers and app bundles come back as `revealed-instead`. Never falls back to the server's
 * `shell.openPath` RPC, so browser and mobile clients get `unavailable-in-browser`.
 */
export function openWithSystemDefault(
  absolutePath: string,
  bridge: ShellPathBridge | undefined = readShellPathBridge(),
): Promise<SystemPathOpenResult> {
  return runShellPathAction("openPath", absolutePath, bridge);
}

/** Reveals a local absolute path in Finder, Explorer or the file manager (desktop only). */
export function revealInFileManager(
  absolutePath: string,
  bridge: ShellPathBridge | undefined = readShellPathBridge(),
): Promise<SystemPathOpenResult> {
  return runShellPathAction("showItemInFolder", absolutePath, bridge);
}
