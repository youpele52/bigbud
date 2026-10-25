import { expect, it } from "vitest";
import {
  validateV2DetachAcknowledgement,
  validateV2LeaseInspection,
} from "./Orchestration.enrollment.ack.ts";

it("wrong detach state/digest/nonce/revision/expiry is not accepted cleanup at either caller", () => {
  const expected = { digest: "a".repeat(64), nonce: "b".repeat(32) },
    inspection = {
      state: "active" as const,
      ownerDigest: expected.digest,
      enrollmentNonce: expected.nonce,
      revision: 2,
      expiry: 2000,
    };
  const ack = { ...inspection, state: "revoked" };
  for (const change of [
    { state: "active" },
    { ownerDigest: "c".repeat(64) },
    { enrollmentNonce: "c".repeat(32) },
    { revision: 3 },
    { expiry: 2001 },
    { extra: true },
  ])
    expect(() =>
      validateV2DetachAcknowledgement({ ...ack, ...change }, expected, inspection),
    ).toThrow();
  expect(validateV2DetachAcknowledgement(ack, expected, inspection)).toMatchObject({
    evidence: "exact-entry",
  });
  const absent = { ...inspection, state: "missing" as const, revision: 0, expiry: 0 };
  expect(
    validateV2DetachAcknowledgement({ ...absent, state: "revoked" }, expected, absent),
  ).toMatchObject({ evidence: "registry-absent" });
});

it("matching native inspect/detach replies cannot legitimize a lease absent from signed acknowledged/pending evidence", () => {
  const expected = { digest: "a".repeat(64), nonce: "b".repeat(32) },
    inspected = {
      state: "active" as const,
      ownerDigest: expected.digest,
      enrollmentNonce: expected.nonce,
      revision: 3,
      expiry: 3000,
    };
  expect(() =>
    validateV2LeaseInspection(inspected, expected, [
      { revision: 1, expiry: 1000 },
      { revision: 2, expiry: 2000 },
    ]),
  ).toThrow("exact retained lease");
  expect(
    validateV2LeaseInspection(inspected, expected, [
      { revision: 2, expiry: 2000 },
      { revision: 3, expiry: 3000 },
    ]),
  ).toEqual(inspected);
});
