import { expect, it } from "vitest";
import { parseRemoteAgentOwner, type RemoteAgentOwner } from "./remoteAgentOwners.ts";
import { profileOwner } from "./remoteAgentOwnedPty.profile.testUtils.ts";

function pending(): RemoteAgentOwner {
  return {
    ...profileOwner(),
    inputAuthority: { id: "controller", pid: 101, startedAt: "start", nonce: "nonce" },
    inputResolved: 0,
    nextInputSequence: 2,
    pendingInput: { sequence: 1, sha256: "a".repeat(64), byteLength: 5 },
  };
}

it("preserves both healthy legacy rows and unknown legacy gaps without invented identity", () => {
  for (const nextInputSequence of [1, 3]) {
    const old = { ...profileOwner(), nextInputSequence };
    expect(parseRemoteAgentOwner(JSON.stringify(old))).toEqual(old);
  }
});

it("preserves bounded pending metadata through serialization", () => {
  expect(parseRemoteAgentOwner(JSON.stringify(pending()))).toEqual(pending());
});

it.each([
  { inputAuthority: undefined },
  { inputResolved: undefined },
  { inputResolved: -1 },
  { inputResolved: 1 },
  { nextInputSequence: 3 },
  { inputAcknowledged: 1 },
  { pendingInput: { sequence: 2, sha256: "a".repeat(64), byteLength: 5 } },
  { pendingInput: { sequence: 1, sha256: "missing", byteLength: 5 } },
  { pendingInput: { sequence: 1, sha256: "a".repeat(64), byteLength: 65537 } },
  { pendingInput: { sequence: 1, sha256: "a".repeat(64), byteLength: -1 } },
])("rejects inconsistent receipt ordering or identity %#", (change) => {
  expect(() => parseRemoteAgentOwner(JSON.stringify({ ...pending(), ...change }))).toThrow();
});

it("cannot present a zero-delivery receipt as a positive written acknowledgement", () => {
  const owner = pending();
  const receipt = { ...owner.pendingInput!, outcome: "not-admitted", writerUsable: true };
  const resolved = {
    ...owner,
    pendingInput: undefined,
    inputResolved: 1,
    inputResolution: receipt,
  };
  expect(parseRemoteAgentOwner(JSON.stringify(resolved)).inputAcknowledged).toBe(0);
  expect(() =>
    parseRemoteAgentOwner(JSON.stringify({ ...resolved, inputAcknowledged: 1 })),
  ).toThrow();
});
