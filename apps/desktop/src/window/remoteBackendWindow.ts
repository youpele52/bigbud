import type { BrowserWindow } from "electron";
import type { DesktopOpenRemoteBackendWindowResult } from "@bigbud/contracts/server/ipc.desktopRemoteBackend.ts";

import type { desktopIpcChannels } from "../main.channels";
import { REMOTE_BACKEND_WINDOW_ROLE, type DesktopWindowRegistry } from "./DesktopWindowRegistry";
import { authorizedHandle, BROAD_RENDERER_ROLES } from "./ipcAuthorization";
import {
  createRemoteBackendAssetHeaders,
  parseRemoteBackendAssetBinding,
  type HeaderInjectionSession,
} from "./remoteBackendWindow.assets";

/** Mirrors `RemoteBackendRelayProfileId`; the renderer re-validates against the relay listing. */
const PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** Query parameter read by `apps/web/src/rpc/backendScope.state.ts`. */
export const REMOTE_BACKEND_QUERY_PARAM = "backend";

type RemoteWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "isMinimized" | "restore" | "show" | "focus" | "once"
> & {
  readonly webContents: Pick<BrowserWindow["webContents"], "id"> & {
    readonly session: HeaderInjectionSession;
  };
};

export interface RemoteBackendWindowsDeps {
  readonly makeWindow: (searchParams: Readonly<Record<string, string>>) => RemoteWindow;
  readonly registry: Pick<DesktopWindowRegistry, "register">;
}

/** Plan decision 2: exactly one window per remote backend profile, never a unified sidebar. */
export function createRemoteBackendWindows(deps: RemoteBackendWindowsDeps) {
  const windows = new Map<string, RemoteWindow>();
  const profiles = new Map<number, string>();
  let assets: ReturnType<typeof createRemoteBackendAssetHeaders> | null = null;

  const open = (profileId: unknown): DesktopOpenRemoteBackendWindowResult => {
    if (typeof profileId !== "string" || !PROFILE_ID.test(profileId))
      return { status: "unavailable", reason: "invalid-profile" };
    const existing = windows.get(profileId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { status: "opened" };
    }
    const window = deps.makeWindow({ [REMOTE_BACKEND_QUERY_PARAM]: profileId });
    const contentsId = window.webContents.id;
    windows.set(profileId, window);
    profiles.set(contentsId, profileId);
    deps.registry.register(REMOTE_BACKEND_WINDOW_ROLE, window as BrowserWindow);
    assets ??= createRemoteBackendAssetHeaders(window.webContents.session);
    window.once("closed", () => {
      if (windows.get(profileId) === window) windows.delete(profileId);
      profiles.delete(contentsId);
      assets?.unbind(contentsId);
    });
    return { status: "opened" };
  };

  /** Only a bound window may bind, and only its own lease (validated loopback + credential). */
  const bindAssets = (webContentsId: number, value: unknown): boolean => {
    if (!profiles.has(webContentsId) || !assets) return false;
    const binding = parseRemoteBackendAssetBinding(value);
    if (!binding) return false;
    assets.bind(webContentsId, binding);
    return true;
  };

  return { open, bindAssets, profileFor: (webContentsId: number) => profiles.get(webContentsId) };
}

export function registerRemoteBackendWindowIpc(input: {
  readonly channels: typeof desktopIpcChannels;
  readonly windows: ReturnType<typeof createRemoteBackendWindows>;
}): void {
  // Any broad renderer may ask to open a window; the profile is re-checked by that window.
  authorizedHandle(input.channels.openRemoteBackendWindow, BROAD_RENDERER_ROLES, (_event, id) =>
    input.windows.open(id),
  );
  authorizedHandle(
    input.channels.bindRemoteBackendAssets,
    [REMOTE_BACKEND_WINDOW_ROLE],
    (event, binding) => input.windows.bindAssets(event.sender.id, binding),
  );
}
