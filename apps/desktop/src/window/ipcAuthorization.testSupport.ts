import type { DesktopWindowRole } from "./DesktopWindowRegistry";
import { configureIpcAuthorization } from "./ipcAuthorization";

/** Test-only fakes for the IPC authorizer: real main-frame object identity. */
export interface FakeIpcSender {
  readonly id: number;
  readonly mainFrame: object;
  readonly isDestroyed: () => boolean;
  readonly once: (event: string, listener: () => void) => void;
}

export function fakeIpcSender(id: number, overrides: Partial<FakeIpcSender> = {}): FakeIpcSender {
  return { id, mainFrame: {}, isDestroyed: () => false, once: () => undefined, ...overrides };
}

/** An event from the sender's current main frame. */
export function mainFrameEvent<S extends { readonly mainFrame: object }>(sender: S) {
  return { sender, senderFrame: sender.mainFrame };
}

/** Configures the process-wide authorizer with an explicit sender -> role map. */
export function authorizeFakeSenders(
  entries: ReadonlyArray<readonly [object, DesktopWindowRole]>,
): void {
  const roles = new Map<object, DesktopWindowRole>(entries);
  configureIpcAuthorization({ getRole: (sender) => roles.get(sender) ?? null });
}
