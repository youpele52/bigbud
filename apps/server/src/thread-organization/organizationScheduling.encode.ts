import { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { optionalUint } from "./organizationProtocol.wireWrite.ts";
import type {
  OrganizationSchedulingSettings,
  OrganizationReceipt,
} from "./organizationProtocol.ts";

export function encodeSchedulingSettings(input: OrganizationSchedulingSettings): Uint8Array {
  const w = new WireWriter();
  w.fieldBool(1, input.idleEnabled);
  w.fieldUint(2, input.idleTimeoutMs);
  w.fieldUint(3, input.idleDestination);
  w.fieldBool(4, input.olderEnabled);
  w.fieldUint(5, input.olderTimeoutMs);
  optionalUint(w, 6, input.presentTarget);
  optionalUint(w, 7, input.targetNotBeforeMs);
  w.fieldUint(8, input.graceMs);
  return w.finish();
}
export function encodeSchedulingReceipt(input: OrganizationReceipt): Uint8Array {
  const w = new WireWriter();
  w.fieldString(1, input.operationId);
  w.fieldUint(2, input.outcome);
  optionalUint(w, 3, input.retryNotBeforeMs);
  w.fieldUint(4, input.resultRevision);
  w.fieldUint(5, input.resultSequence);
  return w.finish();
}
