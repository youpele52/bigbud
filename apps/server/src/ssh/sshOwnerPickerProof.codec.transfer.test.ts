import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { encodeRequest, type PickerProofRequest } from "./sshOwnerPickerProof.codec.ts";
import { decodeOwnerFrame } from "./sshOwnerPickerProof.codec.decode.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  isReservedTransferOutcome,
  RESERVED_TRANSFER_OUTCOMES,
  RESERVED_TRANSFER_VERBS,
} from "./sshOwnerPickerProof.codec.transfer.ts";

const request = (kind: string): PickerProofRequest => ({
  requestId: new Uint8Array([1]),
  ownerEpoch: new Uint8Array([2]),
  generation: new Uint8Array([3]),
  targetId: "fixture-target",
  operation: { kind } as never,
});

const isOperationDenied = (error: unknown) =>
  error instanceof PickerProofOwnerError && error.code === "operationDenied";
const isProtocolError = (error: unknown) =>
  error instanceof PickerProofOwnerError && error.code === "protocolError";

/** A well-formed reply envelope whose only outcome is a reserved tag. */
function reservedOutcomePayload(field: number): Uint8Array {
  const reply = new WireWriter();
  reply.fieldBytes(1, new Uint8Array([1]));
  reply.fieldBytes(2, new Uint8Array([2]));
  reply.fieldBytes(3, new Uint8Array([3]));
  reply.fieldRepeatedMessage(field, new Uint8Array());
  const frame = new WireWriter();
  frame.fieldRepeatedMessage(4, reply.finish());
  return frame.finish();
}

test("the product request encoder refuses both reserved transfer verbs", () => {
  for (const verb of RESERVED_TRANSFER_VERBS) {
    assert.throws(() => encodeRequest(request(verb.wire)), isOperationDenied, verb.wire);
  }
});

test("the product decoder refuses both reserved transfer outcomes", () => {
  for (const outcome of RESERVED_TRANSFER_OUTCOMES) {
    assert.equal(isReservedTransferOutcome(outcome.field), true, outcome.wire);
    assert.throws(() => decodeOwnerFrame(reservedOutcomePayload(outcome.field)), isProtocolError);
  }
  assert.equal(isReservedTransferOutcome(46), false);
  assert.equal(isReservedTransferOutcome(10), false);
});

test("reserved transfer fields still match the frozen protocol declarations", () => {
  const proto = readFileSync(
    new URL("../../../../protocol/ssh-owner/v1.proto", import.meta.url),
    "utf8",
  );
  const operations = /\boneof operation\s*\{([^}]+)\}/.exec(proto)?.[1];
  const outcomes = /\boneof outcome\s*\{([^}]+)\}/.exec(proto)?.[1];
  assert.ok(operations, "missing oneof operation");
  assert.ok(outcomes, "missing oneof outcome");
  for (const verb of RESERVED_TRANSFER_VERBS) {
    assert.match(operations, new RegExp(`\\b${verb.wire}\\s*=\\s*${verb.field}\\s*;`));
  }
  for (const outcome of RESERVED_TRANSFER_OUTCOMES) {
    assert.match(outcomes, new RegExp(`\\b${outcome.wire}\\s*=\\s*${outcome.field}\\s*;`));
  }
  // The boundary is documented as not enabled for real transfers in S1-S4.
  const boundary = readFileSync(
    new URL("../../../../protocol/ssh-owner/v1.transfer.proto", import.meta.url),
    "utf8",
  )
    .replace(/\/\//g, "")
    .replace(/\s+/g, " ");
  assert.match(boundary, /not enabled for real transfers in S1-S4/i);
});
