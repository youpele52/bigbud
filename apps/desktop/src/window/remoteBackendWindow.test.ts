import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import { createRemoteBackendWindows } from "./remoteBackendWindow";
import { createRemoteBackendAssetHeaders } from "./remoteBackendWindow.assets";

type Listener = Parameters<
  Parameters<typeof createRemoteBackendAssetHeaders>[0]["webRequest"]["onBeforeSendHeaders"]
>[1];

function harness() {
  let listener: Listener = null;
  const session = {
    webRequest: {
      onBeforeSendHeaders: vi.fn((_filter: unknown, next: Listener) => {
        listener = next;
      }),
    },
  };
  let nextId = 10;
  const made: Array<{ id: number; params: Readonly<Record<string, string>>; close: () => void }> =
    [];
  const makeWindow = vi.fn((params: Readonly<Record<string, string>>) => {
    const id = nextId++;
    const closed: Array<() => void> = [];
    const window = {
      webContents: { id, session },
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      once: vi.fn((_event: string, handler: () => void) => closed.push(handler)),
    };
    made.push({ id, params, close: () => closed.forEach((handler) => handler()) });
    return window as never;
  });
  const registry = { register: vi.fn() };
  const windows = createRemoteBackendWindows({ makeWindow, registry });
  const send = (webContentsId: number, url: string) => {
    let headers: Record<string, string> | undefined;
    listener?.({ url, webContentsId, requestHeaders: { accept: "*/*" } }, (response) => {
      headers = response.requestHeaders;
    });
    return headers;
  };
  return { windows, made, registry, session, send };
}

const credential = "f".repeat(64);

describe("remote backend windows", () => {
  it("opens one window per profile with the backend query parameter", () => {
    const { windows, made, registry } = harness();
    expect(windows.open("vps-1")).toEqual({ status: "opened" });
    expect(windows.open("vps-1")).toEqual({ status: "opened" });
    expect(windows.open("vps-2")).toEqual({ status: "opened" });
    expect(made.map((entry) => entry.params)).toEqual([{ backend: "vps-1" }, { backend: "vps-2" }]);
    expect(registry.register).toHaveBeenCalledWith("remote-backend", expect.anything());
  });

  it.each([undefined, "", "../etc", "a b", "x".repeat(129)])(
    "refuses an invalid profile ID without creating a window: %s",
    (profileId) => {
      const { windows, made } = harness();
      expect(windows.open(profileId)).toEqual({
        status: "unavailable",
        reason: "invalid-profile",
      });
      expect(made).toHaveLength(0);
    },
  );

  it("adds lease headers only to the bound window's own lease origin", () => {
    const { windows, made, send } = harness();
    windows.open("vps-1");
    const bound = made[0]!.id;
    expect(
      windows.bindAssets(999, { baseUrl: "http://127.0.0.1:4100", localCredential: credential }),
    ).toBe(false);
    expect(
      windows.bindAssets(bound, {
        baseUrl: "http://example.com:4100",
        localCredential: credential,
      }),
    ).toBe(false);
    expect(
      windows.bindAssets(bound, { baseUrl: "http://127.0.0.1:4100", localCredential: "x" }),
    ).toBe(false);
    expect(
      windows.bindAssets(bound, { baseUrl: "http://127.0.0.1:4100", localCredential: credential }),
    ).toBe(true);
    expect(send(bound, "http://127.0.0.1:4100/attachments/a")).toMatchObject({
      Authorization: `Bearer ${credential}`,
      "x-bigbud-client-rpc-revision": "1",
    });
    expect(send(bound, "http://127.0.0.1:3773/attachments/a")).toEqual({ accept: "*/*" });
    expect(send(1, "http://127.0.0.1:4100/attachments/a")).toEqual({ accept: "*/*" });
    made[0]!.close();
    expect(send(bound, "http://127.0.0.1:4100/attachments/a")).toBeUndefined();
  });
});
