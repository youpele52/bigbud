import { expect, it } from "vitest";

import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { readWorkspaceModeInspection } from "./sshOwnerPickerProof.codec.workspaceMode.ts";

const publicationToken = new Uint8Array(32).fill(0x51);
const physicalRoot = "/fixture/root";
const hostIdentity = `machine-v1:${"a".repeat(64)}`;
const realpathSha256 = "b".repeat(64);

function wireReady(generation: number, record?: string) {
  const ready = new WireWriter();
  ready.fieldString(1, physicalRoot);
  ready.fieldString(2, hostIdentity);
  ready.fieldUint(3, 1000);
  ready.fieldString(4, realpathSha256);
  ready.fieldUint(5, generation);
  if (record !== undefined) ready.fieldString(6, record);
  ready.fieldBytes(7, publicationToken);
  return ready.finish();
}

it("retains an exact bounded observation and distinguishes a missing record", () => {
  const ready = (bytes: Uint8Array) => {
    const message = new WireWriter();
    message.fieldRepeatedMessage(1, bytes);
    return readWorkspaceModeInspection(message.finish());
  };
  const absent = {
    state: "ready",
    physicalRoot,
    hostIdentity,
    accountUid: 1000,
    publicationToken,
    realpathSha256,
    generation: 0,
  };
  expect(ready(wireReady(0))).toEqual(absent);
  expect(ready(wireReady(1, '{"generation":1}'))).toEqual({
    ...absent,
    generation: 1,
    currentRecord: '{"generation":1}',
  });
  expect(() => ready(wireReady(0, "unexpected"))).toThrow();
  expect(() => ready(wireReady(1))).toThrow();
  expect(() => ready(wireReady(1, "é".repeat(513)))).toThrow();
});

it("rejects unknown refusals and conflicting result variants", () => {
  const refusal = new WireWriter();
  refusal.fieldUint(2, 127);
  expect(() => readWorkspaceModeInspection(refusal.finish())).toThrow();
  const conflicting = new WireWriter();
  conflicting.fieldRepeatedMessage(1, wireReady(0));
  conflicting.fieldUint(2, 4);
  expect(() => readWorkspaceModeInspection(conflicting.finish())).toThrow();
});
