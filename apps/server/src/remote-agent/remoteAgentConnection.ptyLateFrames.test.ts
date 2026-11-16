import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { RemoteAgentConnection } from "./remoteAgentConnection";
import { encodeDelimitedFrame } from "./remoteAgentProtocol.codec";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";

it("discards unclaimed late PTY frames while preserving live listeners and unrelated replies", async () => {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_bytes: Uint8Array, done: () => void) => {
      done();
      return true;
    }),
    end: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  const Connection = RemoteAgentConnection as unknown as new (
    child: unknown,
    limit: number,
  ) => RemoteAgentConnection;
  const connection = new Connection(child, 4096);
  const emit = (frame: RemoteAgentFrame) =>
    child.stdout.emit("data", Buffer.from(encodeDelimitedFrame(frame, 4096)));
  const expired = new AbortController();
  const pending = connection.request(
    {
      type: "ptyAttachRequest",
      value: { requestId: "expired", ptyId: "retired", afterSequence: 0 },
    },
    (frame) => frame.type === "ptyAttachResponse" && frame.value.requestId === "expired",
    expired.signal,
  );
  const rejection = expect(pending).rejects.toThrow("cancelled");
  expired.abort();
  await rejection;
  emit({
    type: "ptyAttachResponse",
    value: {
      requestId: "expired",
      ptyId: "retired",
      pid: 42,
      state: "running",
      firstRetainedSequence: 1,
      nextSequence: 1,
      replayGap: false,
    },
  });
  for (let sequence = 1; sequence <= 1000; sequence++)
    emit({ type: "ptyOutput", value: { ptyId: "retired", sequence, bytes: new Uint8Array(1024) } });
  emit({
    type: "ptyExited",
    value: {
      ptyId: "retired",
      hasExitCode: true,
      exitCode: 0,
      hasSignal: false,
      signal: 0,
    },
  });
  expect((connection as unknown as { queuedFrames: unknown[] }).queuedFrames).toHaveLength(0);
  const received = vi.fn((frame: RemoteAgentFrame) => frame.type === "ptyOutput");
  const remove = connection.onFrame(received);
  emit({ type: "ptyOutput", value: { ptyId: "active", sequence: 1, bytes: new Uint8Array([65]) } });
  expect(received).toHaveBeenCalledOnce();
  remove();
  const live = connection.request(
    { type: "ptyAttachRequest", value: { requestId: "new", ptyId: "retired", afterSequence: 0 } },
    (frame) => frame.type === "ptyAttachResponse" && frame.value.requestId === "new",
  );
  emit({
    type: "ptyAttachResponse",
    value: {
      requestId: "new",
      ptyId: "retired",
      pid: 42,
      state: "running",
      firstRetainedSequence: 1,
      nextSequence: 1001,
      replayGap: false,
    },
  });
  await expect(live).resolves.toMatchObject({ value: { requestId: "new", pid: 42 } });
  const other: RemoteAgentFrame = {
    type: "ptySignalResponse",
    value: { requestId: "other", ptyId: "other", accepted: true, errorCode: "", errorMessage: "" },
  };
  emit(other);
  await expect(connection.nextFrame()).resolves.toEqual(other);
  expect(stdin.write).toHaveBeenCalledTimes(2);
  expect(stdin.end).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});
