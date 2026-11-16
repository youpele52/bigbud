import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

function fixture() {
  const request = vi.fn(
    async (_frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => ({
      type: "ptyInputResponse",
      value: { requestId: "reply", ptyId: "pty", accepted: true, errorCode: "", errorMessage: "" },
    }),
  );
  const connection = {
    request,
    onFrame: () => () => undefined,
    onFailure: () => () => undefined,
  } as unknown as RemoteAgentConnection;
  const process = new RemoteAgentPtyProcess(connection, "pty", undefined);
  const errors: Error[] = [];
  process.onError((error) => errors.push(error));
  return { process, request, errors };
}

describe("durable remote terminal input ordering", () => {
  it("persists allocation before send and confirmation after acknowledgement", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const allocated = vi.fn(async () => {
      await gate;
    });
    const acknowledged = vi.fn(async () => undefined);
    f.process.setDurability({ allocated, acknowledged, output: async () => undefined });
    f.process.write("input");
    await vi.waitFor(() => expect(allocated).toHaveBeenCalledWith(1, expect.any(Uint8Array)));
    expect(f.request).not.toHaveBeenCalled();
    expect(acknowledged).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(acknowledged).toHaveBeenCalledWith(1));
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      type: "ptyInput",
      value: { sequence: 1 },
    });
  });

  it("does not resend or allocate past ambiguous input when the acknowledgement is lost", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("transport lost after input send"));
    const allocated = vi.fn(async () => undefined);
    f.process.setDurability({
      allocated,
      acknowledged: async () => undefined,
      output: async () => undefined,
    });
    f.process.write("first");
    await vi.waitFor(() => expect(f.errors.length).toBeGreaterThan(0));
    f.process.write("second");
    expect(f.request).toHaveBeenCalledOnce();
    expect(allocated).toHaveBeenCalledOnce();
    expect(f.errors.at(-1)).toMatchObject({ code: "PTY_INPUT_OUTCOME_UNKNOWN" });
  });

  it("legacy attach without an input watermark cannot reconstruct missing pending bytes", () => {
    const f = fixture();
    f.process.restoreSequences(4, 3, 1);
    f.process.write("must not reuse sequence 2 or invent sequence 3");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.errors[0]).toMatchObject({ code: "PTY_INPUT_OUTCOME_UNKNOWN" });
  });

  it("successful same-PID attach and backend reconstruction cannot clear ambiguous input", async () => {
    const f = fixture();
    let next = 1;
    const acknowledged = 0;
    f.process.setDurability({
      allocated: async (sequence) => {
        next = sequence + 1;
      },
      acknowledged: async () => {
        throw new Error("Lost response cannot acknowledge");
      },
      output: async () => {},
    });
    f.request.mockRejectedValueOnce(new Error("lost input acknowledgement"));
    f.process.write("unknown");
    await vi.waitFor(() => expect(f.errors.length).toBeGreaterThan(0));
    const attachResponse: RemoteAgentFrame = {
      type: "ptyAttachResponse",
      value: {
        requestId: "attach",
        ptyId: "pty",
        pid: 42,
        state: "running",
        replayGap: false,
        firstRetainedSequence: 1,
        nextSequence: 1,
      },
    };
    // The fixture only models input replies by default; attach is deliberately legacy.
    f.request.mockResolvedValue(attachResponse);
    await f.process.attach();
    f.process.write("still unknown");
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.errors.at(-1)).toMatchObject({ code: "PTY_INPUT_OUTCOME_UNKNOWN" });
    const restarted = fixture();
    restarted.process.restoreSequences(0, next, acknowledged);
    restarted.request.mockResolvedValue(attachResponse);
    await restarted.process.attach();
    restarted.process.write("no replay on backend restart");
    expect(restarted.request).toHaveBeenCalledOnce();
    expect(restarted.errors.at(-1)).toMatchObject({ code: "PTY_INPUT_OUTCOME_UNKNOWN" });
    expect(restarted.process.pid).toBe(42);
  });

  it("keeps allocating and acknowledging healthy legacy input past 4096 completions", async () => {
    const f = fixture();
    const acknowledged = vi.fn(async () => undefined);
    f.process.setDurability({
      allocated: async () => undefined,
      acknowledged,
      output: async () => undefined,
    });
    // Exercise the actual TS client's serialized chain. Rust's companion
    // regression proves its compacted ledger acknowledges these inputs.
    for (let offset = 0; offset < 4200; offset += 100) {
      for (let index = 0; index < 100; index++) f.process.write("x");
      await vi.waitFor(() => expect(acknowledged).toHaveBeenCalledTimes(offset + 100));
    }
    expect(f.request).toHaveBeenCalledTimes(4200);
    expect(f.request.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "ptyInput",
      value: { sequence: 4200 },
    });
    expect(f.errors).toEqual([]);
  });
});
