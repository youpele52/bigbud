import { describe, expect, it } from "vitest";
import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { readReply } from "./sshOwnerPickerProof.codec.outcome.ts";
import {
  readGuardedWriteStage,
  writeGuardedWriteOperation,
  type GuardedWriteOperation,
} from "./sshOwnerPickerProof.codec.guardedWrite.ts";
import { bytesValue, uintValue } from "./sshOwnerPickerProof.codec.wire.ts";

const lease = new Uint8Array(40).fill(1);
const binding = {
  operationId: "0123456789abcdef0123456789abcdef",
  workspaceRoot: "/disposable/workspace",
  relativePath: "nested/file.txt",
  expectedSha256: new Uint8Array(32).fill(2),
  attemptedSha256: new Uint8Array(32).fill(3),
  bodyBytes: 0,
};

function operand(operation: GuardedWriteOperation) {
  const writer = new WireWriter();
  writeGuardedWriteOperation(writer, operation);
  return writer.finish();
}

function guardedReply(write: (outcome: WireWriter) => void) {
  const outcome = new WireWriter();
  write(outcome);
  const response = new WireWriter();
  response.fieldRepeatedMessage(36, outcome.finish());
  return readReply(response.finish());
}

describe("guarded write staging wire", () => {
  it("writes an explicitly present zero-sized body", () => {
    let foundSize: number | undefined;
    decodeMessage(operand({ kind: "proofGuardedWriteBegin", binding }), (tag, wire, reader) => {
      expect(tag).toBe(55);
      decodeMessage(bytesValue(wire, reader), (field, inner, operandReader) => {
        expect(field).toBe(1);
        decodeMessage(bytesValue(inner, operandReader), (field, wire, bindingReader) => {
          if (field === 6) foundSize = uintValue(wire, bindingReader);
          else bindingReader.skip(wire);
        });
      });
    });
    expect(foundSize).toBe(0);
  });

  it("bounds every chunk and rejects invalid offsets, hashes and lease lengths", () => {
    const maxChunk = new Uint8Array(48 * 1024);
    const chunk = {
      kind: "proofGuardedWriteChunk" as const,
      binding: { ...binding, bodyBytes: 512 * 1024 },
      lease,
      offset: 0,
      data: maxChunk,
    };
    expect(operand(chunk).length).toBeLessThan(64 * 1024);
    const invalid = [
      { ...chunk, data: new Uint8Array(maxChunk.length + 1) },
      { ...chunk, offset: chunk.binding.bodyBytes },
      { ...chunk, binding: { ...binding, relativePath: "../outside" } },
      { ...chunk, binding: { ...binding, expectedSha256: new Uint8Array(31) } },
      { ...chunk, lease: lease.subarray(1) },
    ];
    for (const operation of invalid) expect(() => operand(operation)).toThrow();
  });

  it("distinguishes validated staging from a saved file and rejects ambiguous replies", () => {
    expect(
      guardedReply((writer) => writer.fieldRepeatedMessage(3, new Uint8Array())),
    ).toMatchObject({
      outcome: { kind: "proofGuardedWriteStage", value: { state: "validatedNotDispatched" } },
    });
    expect(guardedReply((writer) => writer.fieldBytes(1, lease))).toMatchObject({
      outcome: { kind: "proofGuardedWriteStage", value: { state: "begun", lease } },
    });
    expect(() => readGuardedWriteStage(new Uint8Array())).toThrow();
    expect(() =>
      guardedReply((writer) => {
        writer.fieldBytes(1, lease);
        writer.fieldRepeatedMessage(4, new Uint8Array());
      }),
    ).toThrow();
  });
});
