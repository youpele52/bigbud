import { beforeEach, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
import { configureIpcAuthorization } from "../window/ipcAuthorization";
import { desktopIpcChannels } from "../main.channels";
import { registerResourceAwarenessIpc } from "./awareness.ipc";

beforeEach(() => {
  handlers.clear();
  configureIpcAuthorization({ getRole: () => "main" });
});
function sender(id: number) {
  const mainFrame = {};
  return { mainFrame, id, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
}
function setup() {
  const owner = {
    state: vi.fn(() => ({ health: "healthy" })),
    listen: vi.fn(),
    mutate: vi.fn(),
    acknowledge: vi.fn(),
  };
  registerResourceAwarenessIpc(owner as never, (candidate) => candidate.id === 1);
  return owner;
}

it("rejects non-main senders and oversized mutations before the settings owner", () => {
  const owner = setup();
  const denied = sender(2);
  expect(() =>
    handlers.get(desktopIpcChannels.resourceAwarenessMutate)!(
      { sender: denied, senderFrame: denied.mainFrame },
      {},
    ),
  ).toThrow("denied");
  const allowed = sender(1);
  expect(() =>
    handlers.get(desktopIpcChannels.resourceAwarenessMutate)!(
      { sender: allowed, senderFrame: allowed.mainFrame },
      { padding: "🔥".repeat(5000) },
    ),
  ).toThrow("too large");
  expect(owner.mutate).not.toHaveBeenCalled();
});

it("hydrates trusted state, fences mutation authorization and bounds acknowledgements", () => {
  const owner = setup();
  const allowed = sender(1);
  const event = { sender: allowed, senderFrame: allowed.mainFrame };
  expect(handlers.get(desktopIpcChannels.resourceAwarenessGet)!(event)).toEqual({
    health: "healthy",
  });
  handlers.get(desktopIpcChannels.resourceAwarenessMutate)!(event, {
    expectedRevision: 0,
    operation: "enable",
    enabled: false,
  });
  expect(owner.mutate).toHaveBeenCalledWith(
    { expectedRevision: 0, operation: "enable", enabled: false },
    expect.any(Function),
  );
  handlers.get(desktopIpcChannels.resourceAwarenessAcknowledge)!(event, ["incident"]);
  expect(owner.acknowledge).toHaveBeenCalledWith(["incident"]);
  expect(() =>
    handlers.get(desktopIpcChannels.resourceAwarenessAcknowledge)!(
      event,
      Array(65).fill("incident"),
    ),
  ).toThrow("invalid");
});
