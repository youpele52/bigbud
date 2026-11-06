import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { schedulingFixtureFrames } from "./organizationScheduling.fixtures.ts";
import { encodeOrganizationFrame } from "./organizationProtocol.encode.ts";
import { decodeOrganizationFrame } from "./organizationProtocol.decode.ts";
import { decodeOrganizationNativeFrame } from "./organizationScheduling.decode.ts";
import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";

it("shares canonical scheduling settings/scope/optional-zero facts with Rust", () => {
  const golden = readFileSync(
    new URL("../../../../protocol/thread-organization/scheduling-fixture.hex", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n");
  expect(
    schedulingFixtureFrames().map((frame) =>
      Buffer.from(encodeOrganizationFrame(frame)).toString("hex"),
    ),
  ).toEqual(golden);
  for (const [i, frame] of schedulingFixtureFrames().entries())
    expect(decodeOrganizationFrame(Uint8Array.from(Buffer.from(golden[i]!, "hex")))).toEqual(frame);
  const receipt = {
    backendNonce: "owner",
    generation: 1,
    type: "receipt" as const,
    value: {
      operationId: "operation",
      outcome: 3,
      retryNotBeforeMs: 2000,
      resultRevision: 0,
      resultSequence: 0,
    },
  };
  expect(decodeOrganizationFrame(encodeOrganizationFrame(receipt))).toEqual(receipt);
  const heartbeat = {
    backendNonce: "owner",
    generation: 1,
    type: "heartbeat" as const,
    value: { sequence: 0 },
  };
  expect(decodeOrganizationFrame(encodeOrganizationFrame(heartbeat))).toEqual(heartbeat);
});

it("decodes native proposals and rejects ambiguous output envelopes", () => {
  const proposal = new WireWriter();
  proposal.fieldString(1, "operation");
  proposal.fieldString(2, "occurrence");
  proposal.fieldString(4, "thread");
  proposal.fieldUint(5, 1);
  proposal.fieldUint(6, 2);
  proposal.fieldUint(7, 3);
  proposal.fieldUint(8, 3);
  proposal.fieldUint(9, 2);
  proposal.fieldUint(10, 2);
  proposal.fieldUint(13, 1000);
  const frame = new WireWriter();
  frame.fieldString(1, "owner");
  frame.fieldUint(2, 1);
  frame.fieldMessage(4, proposal.finish());
  expect(decodeOrganizationNativeFrame(frame.finish())).toEqual({
    backendNonce: "owner",
    generation: 1,
    type: "proposal",
    value: {
      operationId: "operation",
      occurrenceId: "occurrence",
      attempt: 0,
      threadId: "thread",
      factVersion: 1,
      expectedRevision: 2,
      policyVersion: 3,
      from: 3,
      destination: 2,
      reason: 2,
      snoozeIdentity: "",
      createdAtMs: 1000,
    },
  });
  frame.fieldMessage(5, Uint8Array.of(8, 1));
  expect(() => decodeOrganizationNativeFrame(frame.finish())).toThrow("one payload");
});

it("rejects duplicate scheduling singular fields rather than normalizing them", () => {
  const input = new WireWriter();
  input.fieldString(1, "owner");
  input.fieldUint(2, 1);
  const proposal = new WireWriter();
  proposal.fieldString(1, "a");
  proposal.fieldString(1, "b");
  input.fieldMessage(4, proposal.finish());
  expect(() => decodeOrganizationNativeFrame(input.finish())).toThrow("duplicate");
});
