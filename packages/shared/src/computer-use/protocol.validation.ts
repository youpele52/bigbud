import type { ComputerUseFrame, WireRecord } from "./protocol.fields";
import { computerUseProtocol, type ComputerUseChannel } from "./protocol.profile";
import { requireProtocol } from "./protocol.wire";

const isDigest = (value: unknown): boolean => value instanceof Uint8Array && value.length === 32;

/** Shape validation only. Stateful admission/transport authentication is NOT supplied by a codec. */
export function validateFrame(
  { kind, value }: ComputerUseFrame,
  channel: ComputerUseChannel,
): void {
  if (kind !== "hello" && kind !== "protocol_error") {
    const data = kind === "mediated_call" || kind === "operation_result";
    requireProtocol(data === (channel === "data"), "channel");
  }
  if (kind === "apply_policy" || kind === "policy_acknowledged")
    requireProtocol(isDigest(value.digest));
  if (kind === "lookup_operation" || kind === "admit_operation")
    requireProtocol(isDigest(value.request_digest));
  if (kind === "admit_operation")
    requireProtocol(
      typeof value.timeout_ms === "number" &&
        value.timeout_ms >= 10_000 &&
        value.timeout_ms <= 3_600_000,
    );
  if (kind === "mediated_call")
    requireProtocol(value.mcp_frame instanceof Uint8Array && value.mcp_frame.length > 0);
  if (kind === "operation_result")
    requireProtocol(["not_started", "completed", "unknown"].includes(value.completion as string));
  if (kind === "status")
    requireProtocol(typeof value.queued_operations === "number" && value.queued_operations <= 32);
}

/** Must be called only after authenticating the channel and loading a qualified tuple. */
export function validateHello(value: WireRecord, tupleDigest: string): void {
  requireProtocol(
    value.protocol_major === computerUseProtocol.major &&
      value.protocol_minor === computerUseProtocol.minor &&
      value.tuple_digest === tupleDigest &&
      /^[0-9a-f]{64}$/.test(tupleDigest) &&
      ["guard", "owner", "worker", "server", "human-control"].includes(value.role as string) &&
      value.qualification_profile === computerUseProtocol.profile &&
      value.control_frame_bytes === computerUseProtocol.controlFrameBytes &&
      value.data_frame_bytes === computerUseProtocol.dataFrameBytes &&
      typeof value.instance_id === "string" &&
      value.instance_id.length > 0 &&
      typeof value.owner_generation === "string" &&
      value.owner_generation.length > 0,
    "incompatible",
  );
}
