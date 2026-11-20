import { afterEach, expect, it, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { RemoteAgentPtyProcess, remoteAgentPtyReconnectTiming } from "./remoteAgentPtyClient.ts";

const processes: RemoteAgentPtyProcess[] = [];
afterEach(() => {
  for (const process of processes.splice(0)) process.detach();
  delete remoteAgentPtyReconnectTiming.delay;
});

function fixture() {
  let fail!: (error: Error) => void;
  const request = vi.fn(async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
    if (frame.type === "ptyAttachRequest")
      return {
        type: "ptyAttachResponse",
        value: {
          requestId: frame.value.requestId,
          ptyId: "pty",
          pid: 42,
          state: "running",
          nextSequence: 1,
          firstRetainedSequence: 1,
          replayGap: false,
        },
      };
    if (frame.type === "ptyInput")
      return {
        type: "ptyInputResponse",
        value: {
          requestId: frame.value.requestId,
          ptyId: "pty",
          accepted: true,
          errorCode: "",
          errorMessage: "",
        },
      };
    throw new Error("No create, signal, resize or replay allowed");
  });
  const connection = {
    request,
    onFrame: () => () => {},
    onFailure: (callback: typeof fail) => {
      fail = callback;
      return () => {};
    },
    close: vi.fn(),
  } as unknown as RemoteAgentConnection;
  const reconnect = vi.fn(async () => connection);
  const process = new RemoteAgentPtyProcess(connection, "pty", reconnect, 42);
  processes.push(process);
  const notices: Error[] = [];
  process.onError((error) => notices.push(error));
  return { process, connection, reconnect, request, notices, fail: () => fail(new Error("lost")) };
}

async function assertWritable(f: ReturnType<typeof fixture>) {
  f.process.write("new input");
  await vi.waitFor(() =>
    expect(f.request.mock.calls.some(([frame]) => frame.type === "ptyInput")).toBe(true),
  );
  expect(f.notices).toEqual([]);
}

it("already cancelled confirmation leaves healthy input and notices untouched", async () => {
  const f = fixture();
  const signal = AbortSignal.abort(new Error("observer retired"));
  await expect(f.process.confirmAttachment(signal)).rejects.toThrow("observer retired");
  expect(f.request).not.toHaveBeenCalled();
  expect(f.reconnect).not.toHaveBeenCalled();
  await assertWritable(f);
});

it("expired observer cannot re-fence shared recovery that finishes afterward", async () => {
  const f = fixture();
  let resolve!: (connection: RemoteAgentConnection) => void;
  f.reconnect.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.fail();
  const controller = new AbortController();
  const observed = f.process.confirmAttachment(controller.signal);
  const rejected = expect(observed).rejects.toThrow("observer deadline");
  controller.abort(new Error("observer deadline"));
  resolve(f.connection);
  await rejected;
  await assertWritable(f);
  expect(f.reconnect).toHaveBeenCalledOnce();
  expect(f.connection.close).not.toHaveBeenCalled();
});

it("recovery cannot replace the original PID before warm confirmation", async () => {
  const f = fixture();
  remoteAgentPtyReconnectTiming.delay = async () => {};
  f.request.mockImplementation(async (frame) => {
    if (frame.type !== "ptyAttachRequest") throw new Error("No replay allowed");
    return {
      type: "ptyAttachResponse",
      value: {
        requestId: frame.value.requestId,
        ptyId: "pty",
        pid: 99,
        state: "running",
        nextSequence: 1,
        firstRetainedSequence: 1,
        replayGap: false,
      },
    };
  });
  f.fail();
  await expect(f.process.confirmAttachment()).rejects.toThrow();
  expect(f.process.pid).toBe(42);
  expect(f.request.mock.calls.every(([frame]) => frame.type === "ptyAttachRequest")).toBe(true);
  expect(f.connection.close).not.toHaveBeenCalled();
});

it.each(["failed", "writer-unusable"])(
  "refuses final %s input reconciliation without replay",
  async (mode) => {
    const f = fixture();
    const reconcile = vi.fn(async () => {
      if (mode === "failed") throw new Error("receipt unavailable");
      return { nextSequence: 1, resolvedSequence: 0, writerUsable: false };
    });
    f.process.setDurability({
      allocated: vi.fn(),
      acknowledged: vi.fn(),
      output: vi.fn(),
      reconcile,
    });
    await expect(f.process.confirmAttachment()).rejects.toThrow();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(f.process.pid).toBe(42);
    f.process.write("must remain unsent");
    await Promise.resolve();
    expect(f.request.mock.calls.map(([frame]) => frame.type)).toEqual(["ptyAttachRequest"]);
  },
);

it("caller expiry does not abort shared final receipt reconciliation", async () => {
  const f = fixture();
  let finish!: () => void;
  let receiptSignal!: AbortSignal;
  const reconcile = vi.fn((_connection: RemoteAgentConnection, signal: AbortSignal) => {
    receiptSignal = signal;
    return new Promise<{ nextSequence: number; resolvedSequence: number; writerUsable: boolean }>(
      (resolve, reject) => {
        finish = () => resolve({ nextSequence: 1, resolvedSequence: 0, writerUsable: true });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      },
    );
  });
  f.process.setDurability({
    allocated: vi.fn(),
    acknowledged: vi.fn(),
    output: vi.fn(),
    reconcile,
  });
  const controller = new AbortController();
  const pending = f.process.confirmAttachment(controller.signal);
  const rejected = expect(pending).rejects.toThrow("observer deadline");
  await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
  controller.abort(new Error("observer deadline"));
  const aborted = receiptSignal.aborted;
  finish();
  await rejected;
  expect(aborted).toBe(false);
  await assertWritable(f);
});

it("late failure cannot poison a newer recovery on the same connection", async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const pending = f.process.confirmAttachment();
  const rejected = expect(pending).rejects.toThrow("old request failed");
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  f.fail();
  await f.process.retryRecovery();
  reject(new Error("old request failed"));
  await rejected;
  await assertWritable(f);
});
