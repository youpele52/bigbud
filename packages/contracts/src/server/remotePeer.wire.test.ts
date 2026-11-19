import { expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { PeerChildStatus, PeerChildWaiting } from "./remotePeer.wire";

const coordinator = "a".repeat(32);
const dispatchId = "12345678-1234-4123-8123-123456789abc";

const status = {
  dispatchId,
  commandId: `peer:${coordinator}:${dispatchId}`,
  childThreadId: "peer-child-1",
  state: "waiting",
  workflowStatus: "awaiting_approval",
  cancelRequested: false,
  result: null,
} as const;

/** The status shape of workers and coordinators before the `waiting` detail. */
const { waiting: _added, ...previousFields } = PeerChildStatus.fields;
const PreviousPeerChildStatus = Schema.Struct(previousFields);

it("carries a bounded waiting detail: a reason and, for approvals, only the request kind", () => {
  const decoded = Schema.decodeUnknownSync(PeerChildStatus)({
    ...status,
    waiting: { reason: "approval-pending", approvalKind: "command" },
  });
  expect(decoded.waiting).toEqual({ reason: "approval-pending", approvalKind: "command" });
  expect(
    Schema.decodeUnknownSync(PeerChildWaiting)({ reason: "user-input-pending" }).approvalKind,
  ).toBeUndefined();
  expect(() =>
    Schema.decodeUnknownSync(PeerChildWaiting)({ reason: "approval-pending", approvalKind: "rm" }),
  ).toThrow();
  expect(() => Schema.decodeUnknownSync(PeerChildWaiting)({ reason: "paused" })).toThrow();
});

it("stays compatible with the previous status shape in both directions", () => {
  // A previous worker omits the detail.
  expect(Schema.decodeUnknownSync(PeerChildStatus)(status).waiting).toBeUndefined();
  // A previous coordinator ignores it, so a new worker's reply still decodes there.
  const previous = Schema.decodeUnknownSync(PreviousPeerChildStatus)({
    ...status,
    waiting: { reason: "approval-pending", approvalKind: "file-change" },
  });
  expect(previous.state).toBe("waiting");
  expect("waiting" in previous).toBe(false);
});
