import { expect, it } from "vitest";

import { WireReader, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  readProofOpencode,
  writeProofOpencode,
  type ProofOpencodeOperation,
} from "./sshOwnerPickerProof.codec.opencode.ts";

const lease = new Uint8Array(32).fill(7);

function encode(operation: ProofOpencodeOperation): Uint8Array {
  const writer = new WireWriter();
  writeProofOpencode(writer, operation);
  return writer.finish();
}

function scopeFields(bytes: Uint8Array): ReadonlyMap<number, number> {
  const outer = new WireReader(bytes);
  expect(outer.tag()).toEqual({ field: 50, wireType: 2 });
  const operands = new WireReader(outer.bytesValue());
  expect(operands.tag()).toEqual({ field: 3, wireType: 2 });
  const scope = new WireReader(operands.bytesValue());
  const fields = new Map<number, number>();
  while (!scope.done) {
    const { field, wireType } = scope.tag();
    expect(wireType).toBe(field === 1 || field === 3 ? 2 : 0);
    fields.set(field, field === 1 || field === 3 ? scope.bytesValue().length : scope.uint());
  }
  return fields;
}

it("writes the additive v2 transport and keeps v1 bytes unchanged", () => {
  const base = {
    kind: "proofOpencodeOpen" as const,
    lease,
    serviceScope: { threadId: "thread", sessionEpoch: 4, cwd: "/srv/work" },
  };
  const v1 = scopeFields(encode(base));
  expect(v1.has(4)).toBe(false);
  const v1Explicit = scopeFields(
    encode({ ...base, serviceScope: { ...base.serviceScope, transport: "v1" } }),
  );
  expect(v1Explicit.has(4)).toBe(false);
  const v2 = scopeFields(
    encode({ ...base, serviceScope: { ...base.serviceScope, transport: "v2" } }),
  );
  expect(v2.get(4)).toBe(2);
});

it("reads the owner credential only on a ready v2 state", () => {
  const password = "0123456789abcdef".repeat(4);
  const ready = (() => {
    const writer = new WireWriter();
    writer.fieldBytes(1, lease);
    writer.fieldUint(2, 2);
    writer.fieldUint(3, 49_152);
    writer.fieldString(5, password);
    return writer.finish();
  })();
  expect(readProofOpencode(ready)).toEqual({
    lease,
    phase: "ready",
    localPort: 49_152,
    password,
  });
  const closed = (() => {
    const writer = new WireWriter();
    writer.fieldBytes(1, lease);
    writer.fieldUint(2, 4);
    writer.fieldString(5, password);
    return writer.finish();
  })();
  expect(() => readProofOpencode(closed)).toThrow();
  for (const invalid of ["line\nbreak", "x".repeat(300)]) {
    const corrupted = (() => {
      const writer = new WireWriter();
      writer.fieldBytes(1, lease);
      writer.fieldUint(2, 2);
      writer.fieldUint(3, 49_152);
      writer.fieldString(5, invalid);
      return writer.finish();
    })();
    expect(() => readProofOpencode(corrupted)).toThrow();
  }
});
