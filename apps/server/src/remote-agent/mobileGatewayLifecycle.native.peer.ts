/** Controlled wire peer only: no native child, artifact execution or production readiness. */
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import { REMOTE_AGENT_PROTOCOL_MINOR, type RemoteAgentHello } from "./remoteAgentProtocol.ts";
import type { RemoteAgentServiceLeaseResponse } from "./remoteAgentProtocol.serviceLease.ts";

const controller = {
  pid: Number(process.env.BIGBUD_TEST_NATIVE_PID),
  boot: process.env.BIGBUD_TEST_NATIVE_BOOT ?? "fixture-boot",
  started: process.env.BIGBUD_TEST_NATIVE_STARTED ?? "123",
};
const hello: RemoteAgentHello = {
  protocolMajor: 1,
  protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
  agentVersion: "fixture",
  buildDigest: "fixture",
  os: "linux",
  architecture: "aarch64",
  agentInstanceId: "fixture",
  agentEpoch: process.env.BIGBUD_TEST_NATIVE_EPOCH ?? "fixture",
  capabilities: [{ name: "service.lease", major: 1, minor: 2 }],
  maxFrameBytes: 1024 * 1024,
  maxOperationOutputBytes: 1024,
  maxJournalBytes: 1024,
};
let input = Buffer.alloc(0),
  launched = false;
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const size = input.readUInt32BE(0);
    if (size > 1024 * 1024) throw Error("Synthetic native frame exceeds bound.");
    if (input.length < size + 4) return;
    const frame = decodeDelimitedFrame(input.subarray(0, size + 4));
    input = input.subarray(size + 4);
    if (frame.type === "clientHello") {
      process.stdout.write(encodeDelimitedFrame({ type: "agentHello", value: hello }));
      continue;
    }
    if (
      frame.type !== "serviceLeaseStartRequest" &&
      frame.type !== "serviceLeaseControlRequest" &&
      frame.type !== "serviceLeaseStatusRequest" &&
      frame.type !== "serviceLeaseResumeRequest"
    )
      throw Error("Synthetic peer refuses unrelated work.");
    if (frame.type === "serviceLeaseStartRequest") launched = true;
    const action = frame.type === "serviceLeaseControlRequest" ? frame.value.action : "";
    const cancelled = action === "cancel-pending" && !launched;
    const exited = action === "stop-original";
    const value: RemoteAgentServiceLeaseResponse = {
      requestId: frame.value.requestId,
      accepted: true,
      state: cancelled ? "cancelled" : exited ? "exited" : "spawned",
      errorCode: "",
      binding: frame.value.binding,
      generation: cancelled || exited ? 0 : 1,
      originalChildPid: cancelled ? 0 : controller.pid + 1000,
      bootstrap: [],
      originalController: cancelled
        ? undefined
        : {
            ...controller,
            pid: controller.pid + Number(process.env.BIGBUD_TEST_NATIVE_ORIGINAL_PID_OFFSET ?? 0),
          },
      currentController: cancelled || exited ? undefined : controller,
      previousController: undefined,
    };
    const type =
      frame.type === "serviceLeaseStartRequest"
        ? "serviceLeaseStartResponse"
        : frame.type === "serviceLeaseControlRequest"
          ? "serviceLeaseControlResponse"
          : frame.type === "serviceLeaseResumeRequest"
            ? "serviceLeaseResumeResponse"
            : "serviceLeaseStatusResponse";
    process.stdout.write(encodeDelimitedFrame({ type, value }));
  }
});
