import { expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  PEER_RESULT_SUMMARY_MAX_CHARS,
  PeerDispatch,
  PeerDispatchCommandId,
  PeerDispatchState,
  PeerDispatchTransition,
  PeerGrant,
  PeerResultSummary,
} from "./remotePeer";

const coordinator = "a".repeat(32);
const dispatchId = "12345678-1234-4123-8123-123456789abc";
const ceiling = {
  runtimeMode: "approval-required",
  providers: ["codex"],
  workspaceRoots: ["/srv/work"],
} as const;

const grant = {
  grantId: "22345678-1234-4123-8123-123456789abc",
  coordinatorAuthorityId: coordinator,
  coordinatorKeyFingerprint: `sha256:${"b".repeat(64)}`,
  workerAuthorityId: "c".repeat(32),
  actions: ["delegate", "status", "follow", "cancel"],
  ceiling,
  issuedAt: "2026-11-18T00:00:00.000Z",
  expiresAt: "2026-12-18T00:00:00.000Z",
  revokedAt: null,
};

const dispatch = {
  dispatchId,
  commandId: `peer:${coordinator}:${dispatchId}`,
  coordinatorAuthorityId: coordinator,
  coordinatorThreadId: "thread-1",
  requestKey: "invocation:abc",
  worker: {
    workerAuthorityId: "c".repeat(32),
    grantId: grant.grantId,
    workspaceRoot: "/srv/work",
    provider: "codex",
  },
  permissions: ceiling,
  state: "following",
  sendAttempts: 2,
  childThreadId: "child-1",
  cancelRequestedAt: null,
  result: null,
  error: null,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:01.000Z",
};

it("round-trips a peer grant and a dispatch through encode and decode", () => {
  for (const [schema, value] of [
    [PeerGrant, grant],
    [PeerDispatch, dispatch],
  ] as const) {
    const decoded = Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)(value);
    expect(Schema.encodeSync(schema as Schema.Codec<unknown>)(decoded)).toEqual(value);
  }
});

it("rejects grants with unknown or duplicate actions, relative roots or unknown providers", () => {
  const decode = Schema.decodeUnknownSync(PeerGrant);
  for (const actions of [[], ["delegate", "delegate"], ["delegate", "shell"]])
    expect(() => decode({ ...grant, actions })).toThrow();
  expect(() =>
    decode({ ...grant, ceiling: { ...ceiling, workspaceRoots: ["srv/work"] } }),
  ).toThrow();
  expect(() =>
    decode({ ...grant, ceiling: { ...ceiling, workspaceRoots: ["/srv/\u0000x"] } }),
  ).toThrow();
  expect(() => decode({ ...grant, ceiling: { ...ceiling, providers: ["bash"] } })).toThrow();
  expect(() => decode({ ...grant, coordinatorKeyFingerprint: "b".repeat(64) })).toThrow();
});

it("only accepts command ids namespaced by coordinator authority and dispatch id", () => {
  const decode = Schema.decodeUnknownSync(PeerDispatchCommandId);
  expect(decode(`peer:${coordinator}:${dispatchId}`)).toBe(`peer:${coordinator}:${dispatchId}`);
  for (const bad of [
    dispatchId,
    `peer:${coordinator}`,
    `peer:XYZ:${dispatchId}`,
    `cmd:${dispatchId}`,
  ])
    expect(() => decode(bad)).toThrow();
});

it("bounds the result summary and the attachment list", () => {
  const decode = Schema.decodeUnknownSync(PeerResultSummary);
  const base = { outcome: "completed", summary: "ok", truncated: false, attachments: [] };
  expect(decode(base)).toEqual(base);
  expect(() =>
    decode({ ...base, summary: "x".repeat(PEER_RESULT_SUMMARY_MAX_CHARS + 1) }),
  ).toThrow();
  const attachment = {
    name: "a.txt",
    mediaType: "text/plain",
    sizeBytes: 1,
    sha256: "f".repeat(64),
  };
  expect(() =>
    decode({ ...base, attachments: Array.from({ length: 9 }, () => attachment) }),
  ).toThrow();
});

it("lists transitions only between known states, never into pending or out of terminal states", () => {
  const states = new Set<string>(PeerDispatchState.literals);
  for (const transition of PeerDispatchTransition.literals) {
    const [from, to] = transition.split("->");
    expect(states.has(from!) && states.has(to!)).toBe(true);
    expect(to).not.toBe("pending");
    expect(["completed", "failed", "cancelled"]).not.toContain(from);
    if (to === "sent-uncertain") expect(from).toBe("pending");
  }
});
