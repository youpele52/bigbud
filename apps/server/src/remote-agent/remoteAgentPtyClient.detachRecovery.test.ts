import { expect, it, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";
import { RemoteAgentPtyProcess } from "./remoteAgentPtyClient";

it.each([false, true])(
  "reattaches after unconfirmed Detach (transport failure during closing: %s)",
  async (transportFailure) => {
    const frames = new Set<(frame: RemoteAgentFrame) => unknown>();
    const failures = new Set<(error: Error) => void>();
    let subscribed = true;
    const request = vi.fn(async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
      if (frame.type === "ptyDetachRequest") {
        subscribed = false;
        if (transportFailure)
          for (const listener of failures) listener(new Error("transport lost"));
        throw new Error("Detach reply lost after subscription removal");
      }
      if (frame.type === "ptyAttachRequest") {
        subscribed = true;
        return {
          type: "ptyAttachResponse",
          value: {
            requestId: frame.value.requestId,
            ptyId: "persistent",
            pid: 42,
            state: "running",
            nextSequence: 1,
            firstRetainedSequence: 1,
            replayGap: false,
          },
        };
      }
      if (frame.type === "ptyOutputAck")
        return {
          type: "ptyOutputAckResponse",
          value: {
            requestId: frame.value.requestId,
            ptyId: "persistent",
            accepted: true,
            errorCode: "",
            errorMessage: "",
          },
        };
      throw new Error("No launch, input replay or process stop is permitted");
    });
    const close = vi.fn();
    const connection = {
      request,
      close,
      supportsCapability: () => true,
      onFrame: (listener: (frame: RemoteAgentFrame) => unknown) => {
        frames.add(listener);
        return () => frames.delete(listener);
      },
      onFailure: (listener: (error: Error) => void) => {
        failures.add(listener);
        return () => failures.delete(listener);
      },
    } as unknown as RemoteAgentConnection;
    const process = new RemoteAgentPtyProcess(connection, "persistent", async () => connection, 42);
    const exit = vi.fn();
    process.onExit(exit);
    await expect(process.detachRemote()).rejects.toThrow("reply lost");
    expect(subscribed).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    await process.retryRecovery();
    expect(subscribed).toBe(true);
    expect(request.mock.calls.map(([frame]) => frame.type)).toEqual([
      "ptyDetachRequest",
      "ptyAttachRequest",
    ]);
    const data = vi.fn();
    process.onData(data);
    for (const listener of frames)
      listener({
        type: "ptyOutput",
        value: { ptyId: "persistent", sequence: 1, bytes: new TextEncoder().encode("resumed") },
      });
    expect(data).toHaveBeenCalledExactlyOnceWith("resumed");
    expect(request.mock.calls.map(([frame]) => frame.type)).toEqual([
      "ptyDetachRequest",
      "ptyAttachRequest",
      "ptyOutputAck",
    ]);
    expect(frames.size).toBe(1);
    expect(failures.size).toBe(1);
    expect(process.pid).toBe(42);
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    process.detach();
  },
);
