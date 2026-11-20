import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import { WireWriter } from "./remoteAgentProtocol.codec.wire.ts";
import { RemoteAgentProtocolDecodeError, type RemoteAgentFrame } from "./remoteAgentProtocol.ts";

const goldens = Object.fromEntries(
  readFileSync(
    new URL("../../../../protocol/remote-agent/v1.golden.frames", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const [name, hex] = line.split("=", 2);
      return [name, Uint8Array.from(Buffer.from(hex!, "hex"))];
    }),
);

function responseWithStatus(field: number, statusBytes: number[]): Uint8Array {
  const writer = new WireWriter();
  writer.fieldMessage(field, Uint8Array.from(statusBytes));
  const payload = writer.finish();
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length);
  frame.set(payload, 4);
  return frame;
}

describe("PTY launch evidence protocol compatibility", () => {
  for (const launchStatus of [undefined, "unconfirmed"] as const) {
    const suffix = launchStatus ?? "unknown";
    const status = launchStatus === undefined ? {} : { launchStatus };
    const create: RemoteAgentFrame = {
      type: "ptyCreateResponse",
      value: {
        requestId: "create-1",
        ptyId: "pty-1",
        accepted: true,
        pid: 42,
        errorCode: "",
        errorMessage: "",
        ...status,
      },
    };
    it(`matches the shared Rust create golden with ${suffix} evidence`, () => {
      const bytes = goldens[`pty_create_${suffix}`]!;
      expect(encodeDelimitedFrame(create)).toEqual(bytes);
      expect(decodeDelimitedFrame(bytes)).toEqual(create);
      if (launchStatus === undefined) {
        expect(decodeDelimitedFrame(bytes).value).not.toHaveProperty("launchStatus");
      }
    });

    for (const state of launchStatus === undefined ? ["running"] : ["running", "exited"]) {
      const attach: RemoteAgentFrame = {
        type: "ptyAttachResponse",
        value: {
          requestId: "attach-1",
          ptyId: "pty-1",
          state,
          pid: 42,
          nextSequence: 2,
          firstRetainedSequence: 1,
          replayGap: false,
          ...status,
        },
      };
      it(`matches the shared Rust ${state} attach golden with ${suffix} evidence`, () => {
        const name = state === "exited" ? "pty_attach_exited_unconfirmed" : `pty_attach_${suffix}`;
        const bytes = goldens[name]!;
        expect(encodeDelimitedFrame(attach)).toEqual(bytes);
        expect(decodeDelimitedFrame(bytes)).toEqual(attach);
        if (launchStatus === undefined) {
          expect(decodeDelimitedFrame(bytes).value).not.toHaveProperty("launchStatus");
        }
      });
    }
  }

  for (const [frameField, statusField] of [
    [43, 7],
    [52, 8],
  ] as const) {
    const tag = statusField * 8 + 2;
    it(`omits an explicit empty status on response ${frameField}`, () => {
      const decoded = decodeDelimitedFrame(responseWithStatus(frameField, [tag, 0]));
      expect(decoded.value).not.toHaveProperty("launchStatus");
    });

    it(`rejects unknown nonempty status on response ${frameField}`, () => {
      const unknown = [...new TextEncoder().encode("confirmed")];
      expect(() =>
        decodeDelimitedFrame(responseWithStatus(frameField, [tag, unknown.length, ...unknown])),
      ).toThrow("unsupported PTY launch status");
    });

    it(`rejects malformed status fields on response ${frameField}`, () => {
      for (const bytes of [
        [statusField * 8, 1], // Wrong wire type.
        [tag, 11, 117], // Length exceeds the bounded message.
        [tag, 1, 255], // Invalid UTF-8.
        [tag, 128], // Truncated length varint.
      ]) {
        expect(() => decodeDelimitedFrame(responseWithStatus(frameField, bytes))).toThrow(
          RemoteAgentProtocolDecodeError,
        );
      }
    });
  }
});
