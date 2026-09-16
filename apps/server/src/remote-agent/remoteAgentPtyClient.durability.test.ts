import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

function fixture() {
  const request = vi.fn(async (_frame: RemoteAgentFrame) => ({
    type: "ptyInputResponse",
    value: { accepted: true },
  }));
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
    await vi.waitFor(() => expect(allocated).toHaveBeenCalledWith(1));
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
});
