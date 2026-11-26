import { expect, it } from "vitest";

import { decodeMessage } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { bytesValue, stringValue, uintValue } from "./sshOwnerPickerProof.codec.wire.ts";
import { encodeRequest, type PickerProofRequest } from "./sshOwnerPickerProof.codec.ts";
import {
  readWorkspaceEntryMutation,
  readWorkspaceWriteStage,
} from "./sshOwnerPickerProof.codec.workspace.mutation.ts";

const correlation = {
  requestId: Uint8Array.of(1),
  ownerEpoch: Uint8Array.of(2),
  generation: Uint8Array.of(3),
  targetId: "fixture",
};
const binding = {
  operationId: "op-1",
  workspaceRoot: "/fixture/root",
  relativePath: "a.txt",
  bodyBytes: 3,
};
const lease = Uint8Array.from({ length: 40 }, (_, index) => index);

function parseBindingFields(bindingBytes: Uint8Array) {
  const fields: Record<number, string | number> = {};
  decodeMessage(bindingBytes, (field, wire, reader) => {
    if (field === 1) fields[1] = stringValue(wire, reader);
    else if (field === 2) fields[2] = stringValue(wire, reader);
    else if (field === 3) fields[3] = stringValue(wire, reader);
    else if (field === 4) fields[4] = uintValue(wire, reader);
    else reader.skip(wire);
  });
  return fields;
}

function parseBinding(payload: Uint8Array) {
  let bindingBytes: Uint8Array | undefined;
  decodeMessage(payload, (field, wire, reader) => {
    if (field === 1) bindingBytes = bytesValue(wire, reader);
    else reader.skip(wire);
  });
  if (!bindingBytes) throw new Error("missing binding");
  return parseBindingFields(bindingBytes);
}

function requestOperation(request: PickerProofRequest): {
  readonly field: number;
  readonly bytes: Uint8Array;
} {
  const payload = encodeRequest(request);
  let requestBytes: Uint8Array | undefined;
  decodeMessage(payload, (field, wire, reader) => {
    if (field === 5 || field === 3) {
      requestBytes = bytesValue(wire, reader);
      return;
    }
    reader.skip(wire);
  });
  if (!requestBytes) throw new Error("missing request");
  let operation: { field: number; bytes: Uint8Array } | undefined;
  decodeMessage(requestBytes, (field, wire, reader) => {
    if (field >= 10 && field <= 66) {
      operation = { field, bytes: bytesValue(wire, reader) };
      return;
    }
    reader.skip(wire);
  });
  if (!operation) throw new Error("missing operation");
  return operation;
}

it("encodes the staged write binding without shadowing the operation id", () => {
  const begin = requestOperation({
    ...correlation,
    operation: { kind: "proofWorkspaceWriteBegin", binding },
  });
  expect(begin.field).toBe(63);
  expect(parseBinding(begin.bytes)).toEqual({
    1: "op-1",
    2: "/fixture/root",
    3: "a.txt",
    4: 3,
  });
  const chunk = requestOperation({
    ...correlation,
    operation: {
      kind: "proofWorkspaceWriteChunk",
      binding,
      lease,
      offset: 0,
      data: Uint8Array.of(0x61, 0x62, 0x63),
    },
  });
  expect(chunk.field).toBe(64);
  let chunkOffset: number | undefined;
  let chunkData: Uint8Array | undefined;
  decodeMessage(chunk.bytes, (field, wire, reader) => {
    if (field === 1)
      expect(parseBindingFields(bytesValue(wire, reader))).toEqual({
        1: "op-1",
        2: "/fixture/root",
        3: "a.txt",
        4: 3,
      });
    else if (field === 2) expect(bytesValue(wire, reader)).toEqual(lease);
    else if (field === 3) chunkOffset = uintValue(wire, reader);
    else if (field === 4) chunkData = bytesValue(wire, reader);
    else reader.skip(wire);
  });
  expect(chunkOffset).toBeUndefined();
  expect(chunkData).toEqual(Uint8Array.of(0x61, 0x62, 0x63));
});

it("decodes only canonical entry and stage outcomes", () => {
  expect(readWorkspaceEntryMutation(Uint8Array.of(0x0a, 0))).toBe("created");
  expect(readWorkspaceEntryMutation(Uint8Array.of(0x12, 0))).toBe("alreadyExists");
  expect(readWorkspaceEntryMutation(Uint8Array.of(0x1a, 0))).toBe("deleted");
  expect(readWorkspaceEntryMutation(Uint8Array.of(0x22, 0))).toBe("notFound");
  expect(() => readWorkspaceEntryMutation(Uint8Array.of(0x0a))).toThrow();
  expect(readWorkspaceWriteStage(Uint8Array.of(0x0a, 40, ...lease))).toEqual({
    kind: "begun",
    lease,
  });
  expect(readWorkspaceWriteStage(Uint8Array.of(0x10, 6))).toEqual({
    kind: "chunkAccepted",
    nextOffset: 6,
  });
  expect(readWorkspaceWriteStage(Uint8Array.of(0x1a, 0))).toEqual({ kind: "written" });
  expect(readWorkspaceWriteStage(Uint8Array.of(0x22, 0))).toEqual({ kind: "aborted" });
});
