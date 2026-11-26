import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";

import {
  assertDecoded,
  clientFrameMax,
  consume,
  encode,
  frame,
  frameLength,
  framePayload,
  goldens,
  operandPreimage,
  pickerPreimage,
  ownerFrameMax,
  type Message,
} from "./v1.golden.codec.ts";
import {
  assertGrantDigestCoverage,
  assertOneofCoverage,
  assertReservedSentinels,
} from "./v1.golden.coverage.ts";

import {
  UNKNOWN_SENTINEL,
  challenge,
  pickerPath,
  request,
  reply,
  wireCases,
} from "./v1.golden.cases.ts";

test("has positive goldens for every declared v1 frame, operation, and outcome", () => {
  assertReservedSentinels(UNKNOWN_SENTINEL);
  assertOneofCoverage(wireCases);
  assertGrantDigestCoverage(wireCases);
});

test("encodes and inspects checked-in S1 wire bytes", () => {
  const values = goldens("v1.golden.frames");
  for (const [name, fields] of Object.entries(wireCases)) {
    const expected = consume(values, name);
    assert.deepEqual(frame(encode(fields)), expected, name);
    const ownerToClient = [2, 4, 6, 7, 9, 12].some((tag) => fields[0]?.[0] === tag);
    assertDecoded(framePayload(expected, ownerToClient ? ownerFrameMax : clientFrameMax), fields);
  }
  for (const [name, message] of Object.entries({
    truncated_prefix: "prefix",
    empty_payload: "empty",
    oversized_length: "oversized",
    truncated_payload: "length",
    trailing_bytes: "length",
  })) {
    const encoded = consume(values, name);
    assert.throws(() => framePayload(encoded), { message }, name);
  }
  const largestClient = consume(values, "client_maximum_prefix");
  const tooLargeForClient = consume(values, "client_oversized_prefix");
  const largestOwner = consume(values, "owner_maximum_prefix");
  const tooLargeForOwner = consume(values, "owner_oversized_prefix");
  // Header-only checks: reject a length above the directional cap before allocating or reading.
  assert.equal(frameLength(largestClient, clientFrameMax), clientFrameMax);
  assert.throws(() => frameLength(tooLargeForClient, clientFrameMax), { message: "oversized" });
  assert.equal(frameLength(tooLargeForClient, ownerFrameMax), clientFrameMax + 1);
  assert.equal(frameLength(largestOwner, ownerFrameMax), ownerFrameMax);
  assert.throws(() => frameLength(tooLargeForOwner, ownerFrameMax), { message: "oversized" });
  const malformed = framePayload(consume(values, "malformed_protobuf"));
  assert.throws(() => assertDecoded(malformed, wireCases.hello!), /exceeds frame/);
  for (const [name, fields, representative] of [
    ["unknown_payload", [[UNKNOWN_SENTINEL, []]], wireCases.hello!],
    ["unknown_operation", request(UNKNOWN_SENTINEL, []), wireCases.list_home_omitted!],
    ["unknown_outcome", reply(UNKNOWN_SENTINEL, []), wireCases.connected!],
    ["unknown_error_code", reply(10, [[1, UNKNOWN_SENTINEL]]), wireCases.error_operation_denied!],
  ] satisfies readonly (readonly [string, Message, Message])[]) {
    const payload = framePayload(consume(values, name));
    assertDecoded(payload, fields);
    assert.throws(() => assertDecoded(payload, representative));
  }
  assert.deepEqual([...values.keys()], []);
});

test("matches normalized operand preimages and SHA-256 digests", () => {
  const values = goldens("v1.golden.operands");
  const cases = {
    inspect: operandPreimage(10, []),
    connect: operandPreimage(12, []),
    disconnect: operandPreimage(13, []),
    approve: operandPreimage(11, challenge()),
    approve_changed: operandPreimage(11, challenge("00fe00")),
    list_home_omitted: pickerPreimage(),
    list_home_empty: pickerPreimage(""),
    list_path: pickerPreimage(pickerPath),
    list_changed: pickerPreimage(`${pickerPath}/other`),
    list_utf8_decomposed: pickerPreimage(pickerPath.normalize("NFD")),
    list_whitespace: pickerPreimage(`${pickerPath} `),
  };
  for (const [name, preimage] of Object.entries(cases)) {
    assert.deepEqual(preimage, consume(values, `${name}.canonical`), name);
    assert.deepEqual(
      createHash("sha256").update(preimage).digest(),
      consume(values, `${name}.sha256`),
      name,
    );
  }
  assert.deepEqual(cases.list_home_omitted, cases.list_home_empty);
  assert.notDeepEqual(cases.approve, cases.approve_changed);
  assert.notDeepEqual(cases.list_path, cases.list_changed);
  assert.notDeepEqual(cases.list_path, cases.list_utf8_decomposed);
  assert.notDeepEqual(cases.list_path, cases.list_whitespace);
  assert.deepEqual([...values.keys()], []);
});
