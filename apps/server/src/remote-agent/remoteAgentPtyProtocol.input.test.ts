import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { encodeDelimitedFrame, decodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { decodePtyInputReconcileFrame } from "./remoteAgentProtocol.codec.pty.input.ts";

const goldens = Object.fromEntries(
  readFileSync(
    new URL("../../../../protocol/remote-agent/v1.golden.frames", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.split("=")),
);
const identity = {
  requestId: "receipt",
  ptyId: "pty",
  createDigest: new Uint8Array(32).fill(1),
  sequence: 1,
  payloadDigest: new Uint8Array(32).fill(2),
  byteLength: 4,
};

it.each(["request", "written", "retired"])("shares exact Rust input receipt %s golden", (kind) => {
  const frame: RemoteAgentFrame =
    kind === "request"
      ? { type: "ptyInputReconcileRequest", value: { ...identity, expectedEpoch: "epoch" } }
      : {
          type: "ptyInputReconcileResponse",
          value: {
            ...identity,
            agentEpoch: "epoch",
            outcome: kind === "written" ? "written" : "not-admitted",
            bytesWritten: kind === "written" ? 4 : 0,
            writerUsable: true,
            accepted: true,
            errorCode: "",
          },
        };
  const encoded = encodeDelimitedFrame(frame);
  expect(Buffer.from(encoded).toString("hex")).toBe(goldens[`pty_input_reconcile_${kind}`]);
  expect(decodeDelimitedFrame(encoded)).toEqual(frame);
});

it("defaults missing receipt authority to unaccepted and rejects malformed wire", () => {
  expect(decodePtyInputReconcileFrame(65, new Uint8Array())).toMatchObject({
    value: { accepted: false, writerUsable: false, outcome: "", sequence: 0 },
  });
  expect(() => decodePtyInputReconcileFrame(65, new Uint8Array([0x08, 1]))).toThrow();
  expect(decodePtyInputReconcileFrame(63, new Uint8Array())).toBeUndefined();
});
