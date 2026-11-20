import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import { RemoteAgentPtyInput } from "./remoteAgentPtyClient.input.ts";
import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types.ts";
import { encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

const inputResponse = (requestId: string, ptyId = "pty"): RemoteAgentFrame => ({
  type: "ptyInputResponse",
  value: { requestId, ptyId, accepted: true, errorCode: "", errorMessage: "" },
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture() {
  let available = true;
  const allocated = vi.fn(async (_sequence: number) => {});
  const acknowledged = vi.fn(async (_sequence: number) => {});
  const request = vi.fn(async (_frame: RemoteAgentFrame) => {});
  const report = vi.fn<(error: Error) => void>();
  const recover = vi.fn(async () => {});
  const durability = { allocated, acknowledged, output: async () => {} };
  const input = new RemoteAgentPtyInput({
    ptyId: "pty",
    available: () => available,
    durability: () => durability,
    request,
    report,
    recover,
  });
  return {
    input,
    allocated,
    acknowledged,
    request,
    report,
    recover,
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
}

it("refuses known recovery before allocation and preserves the first sequence", async () => {
  const f = fixture();
  f.setAvailable(false);
  f.input.write("not sent");
  expect(f.report.mock.calls[0]?.[0]).toMatchObject({ code: "PTY_INPUT_NOT_SENT" });
  expect(f.allocated).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  f.setAvailable(true);
  f.input.write("fresh input");
  await vi.waitFor(() => expect(f.acknowledged).toHaveBeenCalledWith(1));
  expect(f.allocated).toHaveBeenCalledExactlyOnceWith(1, expect.any(Uint8Array));
});

it("rechecks queued input before allocation, without reserving or skipping a sequence", async () => {
  const f = fixture();
  const blocked = gate();
  f.acknowledged.mockImplementationOnce(async () => blocked.promise);
  f.input.write("first");
  f.input.write("queued before recovery");
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  f.setAvailable(false);
  blocked.release();
  await vi.waitFor(() => expect(f.input.pending).toBe(false));
  expect(f.allocated).toHaveBeenCalledExactlyOnceWith(1, expect.any(Uint8Array));
  expect(f.report.mock.calls[0]?.[0]).toMatchObject({ code: "PTY_INPUT_NOT_SENT" });
  f.setAvailable(true);
  f.input.write("new input after recovery");
  await vi.waitFor(() => expect(f.acknowledged).toHaveBeenCalledWith(2));
  expect(
    f.request.mock.calls.map(([frame]) => frame.type === "ptyInput" && frame.value.sequence),
  ).toEqual([1, 2]);
});

it.each(["allocation", "request", "acknowledgement"] as const)(
  "keeps %s failure fenced with its cause and a non-secret stage",
  async (stage) => {
    const f = fixture();
    const cause = new Error("sensitive original diagnostic");
    ({ allocation: f.allocated, request: f.request, acknowledgement: f.acknowledged })[
      stage
    ].mockRejectedValueOnce(cause);
    f.input.write("uncertain");
    await vi.waitFor(() => expect(f.input.pending).toBe(false));
    expect(f.report.mock.calls[0]?.[0]).toMatchObject({
      code: "PTY_INPUT_OUTCOME_UNKNOWN",
      inputStage: stage,
      cause,
    });
    expect(f.report.mock.calls[0]?.[0].message).not.toContain(cause.message);
    const sends = f.request.mock.calls.length;
    f.input.write("must not advance");
    expect(f.allocated).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledTimes(sends);
    expect(f.report.mock.calls.at(-1)?.[0]).toMatchObject({ code: "PTY_INPUT_OUTCOME_UNKNOWN" });
  },
);

it("does not reinterpret a lifecycle change during allocation as safe rollback", async () => {
  const f = fixture();
  const blocked = gate();
  f.allocated.mockImplementationOnce(async () => blocked.promise);
  f.request.mockRejectedValueOnce(new Error("cancelled before transport write"));
  f.input.write("allocated");
  await vi.waitFor(() => expect(f.allocated).toHaveBeenCalledOnce());
  f.setAvailable(false);
  blocked.release();
  await vi.waitFor(() => expect(f.input.pending).toBe(false));
  f.setAvailable(true);
  f.input.write("must stay fenced");
  expect(f.allocated).toHaveBeenCalledExactlyOnceWith(1, expect.any(Uint8Array));
  expect(f.report.mock.calls.at(-1)?.[0]).toMatchObject({ code: "PTY_INPUT_OUTCOME_UNKNOWN" });
});

it.each(["x".repeat(64 * 1024 + 1), "€".repeat(24 * 1024)])(
  "rejects oversized encoded input without creating durable uncertainty",
  async (data) => {
    const f = fixture();
    f.input.write(data);
    expect(f.report.mock.calls[0]?.[0]).toMatchObject({ code: "PTY_INPUT_LIMIT" });
    expect(f.allocated).not.toHaveBeenCalled();
    f.input.write("valid");
    await vi.waitFor(() => expect(f.acknowledged).toHaveBeenCalledWith(1));
  },
);

it.each([
  { count: 256, data: "" },
  { count: 8, data: "x".repeat(64 * 1024) },
])(
  "bounds queued items and bytes while a request is stalled ($count entries)",
  async ({ count, data }) => {
    const f = fixture();
    const blocked = gate();
    f.request.mockImplementationOnce(async () => blocked.promise);
    for (let index = 0; index < count + 1; index++) f.input.write(data);
    expect(f.report.mock.calls[0]?.[0]).toMatchObject({ code: "PTY_INPUT_BACKPRESSURE" });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    expect(f.allocated).toHaveBeenCalledOnce();
    blocked.release();
    await vi.waitFor(() => expect(f.input.pending).toBe(false));
    expect(f.acknowledged).toHaveBeenCalledTimes(count);
    expect(f.acknowledged).toHaveBeenLastCalledWith(count);
  },
);

it.each(["failure", "retirement"] as const)(
  "process wiring refuses %s before queued input allocates",
  async (mode) => {
    let failed!: (error: Error) => void;
    const request = vi.fn();
    const connection = {
      request,
      onFrame: () => () => {},
      onFailure: (listener: typeof failed) => {
        failed = listener;
        return () => {};
      },
    } as unknown as RemoteAgentConnection;
    const process = new RemoteAgentPtyProcess(connection, "pty", undefined);
    const allocated = vi.fn(async () => {});
    process.setDurability({ allocated, acknowledged: async () => {}, output: async () => {} });
    const errors: Error[] = [];
    process.onError((error) => errors.push(error));
    process.write("queued");
    if (mode === "failure") failed(new Error("link closed"));
    else process.retireControlRequests();
    await vi.waitFor(() =>
      expect(
        errors.some(
          (error) => error instanceof RemoteAgentPtyError && error.code === "PTY_INPUT_NOT_SENT",
        ),
      ).toBe(true),
    );
    expect(allocated).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    process.detach();
  },
);

it("does not consume a stale queued acknowledgement instead of sending exact input", async () => {
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
  emit(inputResponse("pty:input:0"));
  const process = new RemoteAgentPtyProcess(connection, "pty", undefined);
  const acknowledged = vi.fn(async () => {});
  process.setDurability({ allocated: async () => {}, acknowledged, output: async () => {} });
  process.write("once");
  await vi.waitFor(() => expect(stdin.write).toHaveBeenCalledOnce());
  expect(acknowledged).not.toHaveBeenCalled();
  emit(inputResponse("pty:input:1", "different-pty"));
  await Promise.resolve();
  expect(acknowledged).not.toHaveBeenCalled();
  emit(inputResponse("pty:input:1"));
  await vi.waitFor(() => expect(acknowledged).toHaveBeenCalledExactlyOnceWith(1));
  expect(stdin.write).toHaveBeenCalledOnce();
  process.detach();
  connection.close();
});

it("waits for an in-flight durable allocation before reading recovery identity", async () => {
  const blocked = gate();
  let committed = false;
  const allocated = vi.fn(async () => {
    await blocked.promise;
    committed = true;
  });
  const reconcile = vi.fn(async () => {
    expect(committed).toBe(true);
    return { nextSequence: 2, resolvedSequence: 1, writerUsable: true };
  });
  const input = new RemoteAgentPtyInput({
    ptyId: "pty",
    available: () => true,
    durability: () => ({ allocated, acknowledged: async () => {}, output: async () => {} }),
    request: async () => {},
    recover: async () => {},
    report: () => {},
    reconcile,
  });
  input.write("one allocation");
  await vi.waitFor(() => expect(allocated).toHaveBeenCalledOnce());
  const recovering = input.reconcile();
  input.write("refused during reconciliation");
  expect(reconcile).not.toHaveBeenCalled();
  blocked.release();
  await recovering;
  await vi.waitFor(() => expect(input.pending).toBe(false));
  expect(allocated).toHaveBeenCalledOnce();
  expect(reconcile).toHaveBeenCalledOnce();
});

it("does not enable input for a receipt with an unusable native writer", async () => {
  const request = vi.fn(async () => {});
  const allocated = vi.fn(async () => {});
  const report = vi.fn();
  const input = new RemoteAgentPtyInput({
    ptyId: "pty",
    available: () => true,
    durability: () => ({ allocated, acknowledged: async () => {}, output: async () => {} }),
    request,
    recover: async () => {},
    report,
    reconcile: async () => ({ nextSequence: 2, resolvedSequence: 1, writerUsable: false }),
  });
  input.restore(2, 0);
  await input.reconcile();
  input.write("must remain unavailable");
  expect(report.mock.calls.map(([error]) => error.code)).toEqual([
    "PTY_INPUT_UNAVAILABLE",
    "PTY_INPUT_NOT_SENT",
  ]);
  expect(allocated).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
