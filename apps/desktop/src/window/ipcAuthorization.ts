import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";

import {
  COMPUTER_USE_SAFETY_ROLE,
  desktopWindowRoles,
  type DesktopWindowRegistry,
  type DesktopWindowRole,
} from "./DesktopWindowRegistry";
import { configureRendererWindows } from "./rendererWindows";

/**
 * Every-handler IPC authorization (plan M4 "Audit every reachable IPC
 * registration"). A sender is authorized only when ALL hold: its WebContents
 * is live and currently registered under one of the channel's explicit roles;
 * the message came from that WebContents' main frame (`senderFrame` is the
 * current `mainFrame`). Unknown senders, subframes, destroyed frames and the
 * restricted safety role (outside its own channels) deny with a bounded
 * value: `null` for invoke, `returnValue = null` for sync messages. Until
 * configured, every sender is denied (fail closed).
 *
 * Stale documents are denied only best-effort: Electron reports a null
 * `senderFrame` for a destroyed frame, but after a same-frame navigation it
 * may resolve the frame lazily to the NEW document, so a message sent by the
 * old document can be attributed to the new one. The role binding still
 * holds (same WebContents, same role); no per-document generation is checked.
 * Not yet verified in a real Electron run.
 */
export type IpcRoles = ReadonlyArray<DesktopWindowRole>;

/** The roles that previously reached every unguarded channel; legacy behaviour. */
export const BROAD_RENDERER_ROLES: IpcRoles = desktopWindowRoles;
export const SAFETY_RENDERER_ROLES: IpcRoles = [COMPUTER_USE_SAFETY_ROLE];

export interface IpcSenderEvent {
  readonly sender: WebContents;
  readonly senderFrame: Electron.WebFrameMain | null;
}

export function isAuthorizedIpcSender(
  registry: Pick<DesktopWindowRegistry, "getRole">,
  event: IpcSenderEvent,
  roles: IpcRoles,
): boolean {
  // Any exception while inspecting a sender is a denial, never a crash.
  try {
    const sender = event?.sender;
    if (!sender || sender.isDestroyed()) return false;
    const role = registry.getRole(sender);
    if (role === null || !roles.includes(role)) return false;
    const frame = event.senderFrame;
    return frame !== null && frame !== undefined && frame === sender.mainFrame;
  } catch {
    return false;
  }
}

let authorize: (event: IpcSenderEvent, roles: IpcRoles) => boolean = () => false;

/** Called once at bootstrap, before any handler registration. */
export function configureIpcAuthorization(registry: Pick<DesktopWindowRegistry, "getRole">): void {
  authorize = (event, roles) => isAuthorizedIpcSender(registry, event, roles);
  configureRendererWindows(registry);
}

export function isIpcSenderAuthorized(event: IpcSenderEvent, roles: IpcRoles): boolean {
  return authorize(event, roles);
}

/** `ipcMain.handle` replacement: remove, then register behind the authorizer. */
export function authorizedHandle<Args extends unknown[]>(
  channel: string,
  roles: IpcRoles,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (event, ...args) =>
    authorize(event, roles) ? listener(event, ...(args as Args)) : null,
  );
}

/** `ipcMain.on` replacement; denial answers sync callers with `null`, never hangs. */
export function authorizedOn<Args extends unknown[]>(
  channel: string,
  roles: IpcRoles,
  listener: (event: IpcMainEvent, ...args: Args) => void,
): void {
  ipcMain.removeAllListeners(channel);
  ipcMain.on(channel, (event, ...args) => {
    if (!authorize(event, roles)) {
      event.returnValue = null;
      return;
    }
    listener(event, ...(args as Args));
  });
}
