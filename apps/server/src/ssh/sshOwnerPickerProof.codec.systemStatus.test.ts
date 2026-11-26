import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { readLaneOutcome, writeLaneOperation } from "./sshOwnerPickerProof.codec.lane.ts";
import { readSystemStatusOutcome } from "./sshOwnerPickerProof.codec.systemStatus.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const frames = new Map(
  readFileSync(new URL("../../../../protocol/ssh-owner/v1.golden.frames", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);

const field = (tag: number, value: Uint8Array) => {
  const writer = new WireWriter();
  writer.fieldRepeatedMessage(tag, value);
  return writer.finish();
};

describe("W7 sample_system_status codec", () => {
  it("encodes exactly the golden operand-free request through the lane codec", () => {
    const writer = new WireWriter();
    writeLaneOperation(writer, new WireWriter(), { kind: "sampleSystemStatus" });
    const hex = Buffer.from(writer.finish()).toString("hex");
    expect(hex).toBe("a20b00");
    expect(frames.get("sample_system_status")?.endsWith(hex)).toBe(true);
  });

  it("decodes the golden reply and refuses incomplete or duplicated samples", () => {
    const hex = frames.get("system_status_sample")!;
    const body = Buffer.from(hex.slice(hex.lastIndexOf("aa06") + 6), "hex");
    expect(readLaneOutcome(101, body)).toEqual({
      kind: "systemStatusSample",
      value: "###OS###\nLinux\n###CPU###\ncpu  1 0 1 8 0 0 0 0 0 0\n###END###\n",
    });
    const text = (value: string) => field(1, Buffer.from(value));
    expect(() => readSystemStatusOutcome(text("###OS###\nLinux\n"))).toThrow(PickerProofOwnerError);
    expect(() => readSystemStatusOutcome(new Uint8Array())).toThrow(PickerProofOwnerError);
    const twice = Buffer.concat([text("###END###\n"), text("###END###\n")]);
    expect(() => readSystemStatusOutcome(twice)).toThrow(PickerProofOwnerError);
    expect(() => readSystemStatusOutcome(field(2, Buffer.from("x")))).toThrow(
      PickerProofOwnerError,
    );
  });
});
