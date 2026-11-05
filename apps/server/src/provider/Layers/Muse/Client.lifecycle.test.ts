import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./Adapter.failures.test.helpers.ts";

const sdk = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("@muse-code/sdk", () => ({ spawnMspConnection: sdk.spawn }));
import { makeSdkMuseHostFactory } from "./Client.lifecycle.ts";

function fakeSdk() {
  const initialized = deferred<ReturnType<typeof spawned>>();
  const exited = deferred<{ code: number | null; signal: null }>();
  const closed = deferred<void>();
  let protocolError: ((cause: unknown) => void) | undefined;
  const command = vi.fn(async () => ({}));
  const close = vi.fn(async () => ({ code: 0, signal: null }));
  function spawned() {
    return {
      initializeResult: { grantedCapabilities: ["sessionMcp"], sessionDurability: "durable" },
      connection: {
        closed: closed.promise,
        command,
        request: vi.fn(),
        mintCommandId: () => "cmd",
        onNotification: vi.fn(),
        onServerRequest: vi.fn(),
      },
      close,
      exited: exited.promise,
    };
  }
  const handshake = {
    initialize: vi.fn(() => initialized.promise),
    close,
    exited: exited.promise,
    onNotification: vi.fn(),
    onServerRequest: vi.fn(),
    onProtocolError: (handler: (cause: unknown) => void) => {
      protocolError = handler;
    },
  };
  sdk.spawn.mockReturnValue(handshake);
  return {
    initialized,
    exited,
    closed,
    command,
    close,
    spawned,
    protocolError: (cause: unknown) => protocolError?.(cause),
  };
}

beforeEach(() => sdk.spawn.mockReset());
afterEach(() => vi.useRealTimers());

describe("Muse SDK host lifecycle (mock SDK, no native spawn)", () => {
  it("does not spawn an already-aborted startup", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      makeSdkMuseHostFactory()({ binaryPath: "muse", cwd: process.cwd(), signal: abort.signal }),
    ).rejects.toThrow("before spawn");
    expect(sdk.spawn).not.toHaveBeenCalled();
  });
  it("aborts the owned handshake promptly even if initialize never resolves", async () => {
    const fake = fakeSdk();
    const abort = new AbortController();
    const pending = makeSdkMuseHostFactory()({
      binaryPath: "muse",
      cwd: process.cwd(),
      signal: abort.signal,
    });
    const rejection = expect(pending).rejects.toThrow("aborted");
    abort.abort();
    await rejection;
    expect(fake.close).toHaveBeenCalled();
  });
  it("closes on handshake timeout", async () => {
    vi.useFakeTimers();
    const fake = fakeSdk();
    const pending = makeSdkMuseHostFactory(50)({ binaryPath: "muse", cwd: process.cwd() });
    const rejection = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(fake.close).toHaveBeenCalled();
  });
  it.each(["connection", "child", "protocol"])(
    "forwards unexpected %s loss once and keeps command maxAttempts:1",
    async (loss) => {
      const fake = fakeSdk();
      const onExit = vi.fn();
      const pending = makeSdkMuseHostFactory()({ binaryPath: "muse", cwd: process.cwd(), onExit });
      fake.initialized.resolve(fake.spawned());
      const transport = await pending;
      await transport.command("turn/start", { commandId: "cmd" }, "cmd");
      expect(fake.command).toHaveBeenCalledWith(
        "turn/start",
        { commandId: "cmd" },
        { commandId: "cmd", maxAttempts: 1 },
      );
      if (loss === "connection") fake.closed.resolve();
      else if (loss === "child") fake.exited.resolve({ code: 1, signal: null });
      else fake.protocolError(new Error("bad frame"));
      await Promise.resolve();
      fake.exited.resolve({ code: 1, signal: null });
      fake.protocolError(new Error("bad frame"));
      await Promise.resolve();
      expect(onExit).toHaveBeenCalledTimes(1);
      await transport.close();
    },
  );
  it("suppresses intentional-close exit notifications", async () => {
    const fake = fakeSdk();
    const onExit = vi.fn();
    const pending = makeSdkMuseHostFactory()({ binaryPath: "muse", cwd: process.cwd(), onExit });
    fake.initialized.resolve(fake.spawned());
    const transport = await pending;
    await transport.close();
    fake.closed.resolve();
    fake.exited.resolve({ code: 0, signal: null });
    await Promise.resolve();
    expect(onExit).not.toHaveBeenCalled();
  });
});
