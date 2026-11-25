import { expect, it } from "vitest";
import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { proofRequestPolicy } from "./sshOwnerPickerProof.client.requestPolicy.ts";
import { readReply } from "./sshOwnerPickerProof.codec.outcome.ts";
import { encodeRequest } from "./sshOwnerPickerProof.codec.ts";
import { bytesValue } from "./sshOwnerPickerProof.codec.wire.ts";

const operation = {
  kind: "proofWorkspaceCreate" as const,
  workspaceRoot: "/fixture/workspace",
  relativePath: "folder/file",
  contents: new Uint8Array(48 * 1024),
};
const id = new Uint8Array(32);

it("uses a distinct bounded, mutation-classified request", () => {
  const request = {
    requestId: id,
    ownerEpoch: id,
    generation: id,
    targetId: "fixture",
    operation,
  };
  const fields: number[] = [];
  decodeMessage(encodeRequest(request), (_field, wire, frame) => {
    decodeMessage(bytesValue(wire, frame), (field, wire, reader) => {
      fields.push(field);
      reader.skip(wire);
    });
  });
  expect(fields).toContain(60);
  expect(fields).not.toContain(22);
  expect(proofRequestPolicy(operation)).toMatchObject({ proofMutation: true });
  for (const invalid of [
    { ...operation, contents: new Uint8Array(operation.contents.length + 1) },
    { ...operation, relativePath: "../file" },
  ]) {
    expect(() => encodeRequest({ ...request, operation: invalid })).toThrow();
  }
});

it("requires one exact create outcome and distinguishes collisions", () => {
  const reply = (bytes: number[]) => {
    const writer = new WireWriter();
    writer.fieldRepeatedMessage(38, new Uint8Array(bytes));
    return readReply(writer.finish()).outcome;
  };
  expect(reply([0x0a, 0])).toEqual({ kind: "proofWorkspaceCreateResult", value: "created" });
  expect(reply([0x12, 0])).toEqual({ kind: "proofWorkspaceCreateResult", value: "alreadyExists" });
  for (const bytes of [[], [0x0a, 0, 0x12, 0], [0x0a, 2, 8, 1], [0x1a, 0]]) {
    expect(() => reply(bytes)).toThrow();
  }
});
