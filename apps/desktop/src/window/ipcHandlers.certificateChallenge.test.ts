import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
const ipcMain = vi.hoisted(() => ({
  handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) =>
    handlers.set(channel, handler),
  ),
  removeHandler: vi.fn(),
}));
const app = vi.hoisted(() => ({ on: vi.fn() }));

vi.mock("electron", () => ({ app, ipcMain }));

import {
  registerCertificateChallengeHandlers,
  registerCertificateChallengeIpcHandler,
} from "./ipcHandlers.certificateChallenge";

describe("certificate challenge IPC", () => {
  beforeEach(() => {
    handlers.clear();
    app.on.mockClear();
    ipcMain.handle.mockClear();
    ipcMain.removeHandler.mockClear();
  });

  it("delegates only a narrowly validated resolution with the IPC sender", () => {
    const resolve = vi.fn(() => true);
    registerCertificateChallengeIpcHandler({ resolve } as never);
    const handler = handlers.get("desktop:resolve-certificate-challenge");
    const sender = { id: 1 };

    expect(handler?.({ sender }, { challengeId: "", guestWebContentsId: 2, allow: true })).toBe(
      false,
    );
    expect(resolve).not.toHaveBeenCalled();

    expect(
      handler?.({ sender }, { challengeId: "challenge-1", guestWebContentsId: 2, allow: true }),
    ).toBe(true);
    expect(resolve).toHaveBeenCalledWith(sender, {
      challengeId: "challenge-1",
      guestWebContentsId: 2,
      allow: true,
    });
  });

  it("registers the app certificate handler once while refreshing IPC registration", () => {
    registerCertificateChallengeHandlers();
    registerCertificateChallengeHandlers();

    expect(app.on).toHaveBeenCalledOnce();
    expect(app.on).toHaveBeenCalledWith("certificate-error", expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(
      "desktop:resolve-certificate-challenge",
      expect.any(Function),
    );
  });
});
