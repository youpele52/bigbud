import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import { RemoteAgentPtyProcess } from "./remoteAgentPtyClient";
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";

function fixture(supported = true, accepted = true) {
  const remove = vi.fn();
  const request = vi.fn(async (frame: RemoteAgentFrame) => ({
    type: "ptyDetachResponse",
    value: { ...frame.value, accepted, errorCode: "", errorMessage: "" },
  }));
  const connection = {
    supportsCapability: () => supported,
    onFrame: () => remove,
    onFailure: () => remove,
    request,
    close: vi.fn(),
  } as unknown as RemoteAgentConnection;
  return {
    process: new RemoteAgentPtyProcess(connection, "pty-a", undefined),
    connection,
    request,
    remove,
  };
}

describe("explicit remote Detach", () => {
  it("refuses old capabilities without a request or local listener cleanup", async () => {
    const f = fixture(false);
    await expect(f.process.detachRemote()).rejects.toThrow("does not support Detach");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("retires local listeners only after acknowledgement without close or exit", async () => {
    const f = fixture();
    const exit = vi.fn();
    f.process.onExit(exit);
    await f.process.detachRemote();
    expect(f.request.mock.calls[0]?.[0].type).toBe("ptyDetachRequest");
    expect(f.remove).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
    expect(f.connection.close).not.toHaveBeenCalled();
    f.process.write("not sent");
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("retains local listeners after rejected detach", async () => {
    const f = fixture(true, false);
    await expect(f.process.detachRemote()).rejects.toThrow("not acknowledged");
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.connection.close).not.toHaveBeenCalled();
  });
  it.each<RemoteAgentFrame>([
    { type: "ptyDetachRequest", value: { requestId: "detach", ptyId: "pty" } },
    {
      type: "ptyDetachResponse",
      value: { requestId: "detach", ptyId: "pty", accepted: true, errorCode: "", errorMessage: "" },
    },
  ])("round trips $type without changing existing fields", (frame) => {
    const name = frame.type === "ptyDetachRequest" ? "pty_detach_request" : "pty_detach_response";
    const golden = readFileSync(
      new URL("../../../../protocol/remote-agent/v1.golden.frames", import.meta.url),
      "utf8",
    )
      .split("\n")
      .find((line) => line.startsWith(`${name}=`))
      ?.split("=")[1];
    expect(Buffer.from(encodeDelimitedFrame(frame)).toString("hex")).toBe(golden);
    expect(decodeDelimitedFrame(encodeDelimitedFrame(frame))).toEqual(frame);
  });
});
