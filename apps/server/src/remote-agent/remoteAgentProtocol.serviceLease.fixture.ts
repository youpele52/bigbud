import type {
  RemoteAgentServiceLeaseBinding,
  RemoteAgentServiceLeaseFrame,
} from "./remoteAgentProtocol.serviceLease.ts";
/** Synthetic wire compatibility fixtures, never an account/native admission. */
export const serviceLeaseGoldenBinding: RemoteAgentServiceLeaseBinding = {
  authority: "a".repeat(32),
  installation: `sha256:${"b".repeat(64)}`,
  nativeEpoch: "epoch-1",
  nonce: "lease-1",
  publicationSha256: new Uint8Array(32).fill(1),
  executableSha256: new Uint8Array(32).fill(2),
  assetsSha256: new Uint8Array(32).fill(3),
  configurationSha256: new Uint8Array(32).fill(4),
  guardSha256: new Uint8Array(32).fill(5),
};
const query = {
  requestId: "lease-request-1",
  binding: serviceLeaseGoldenBinding,
  capability: new Uint8Array(32).fill(7),
};
const controller = { pid: 42, boot: "fixture-boot", started: "123" };
const response = {
  requestId: query.requestId,
  accepted: true,
  state: "spawned",
  errorCode: "",
  binding: query.binding,
  generation: 1,
  originalChildPid: 43,
  bootstrap: [],
  originalController: controller,
  currentController: controller,
  previousController: undefined,
};
const resumed = {
  ...response,
  bootstrap: [{ name: "UPSTREAM_CREDENTIAL", value: "synthetic-fixture-only" }],
  currentController: { ...controller, pid: 44, started: "125" },
  previousController: controller,
  generation: 2,
};
export const serviceLeaseGoldenFrames: ReadonlyArray<
  readonly [string, RemoteAgentServiceLeaseFrame]
> = [
  [
    "lease_empty_argument",
    {
      type: "serviceLeaseStartRequest",
      value: {
        ...query,
        assetsGeneration: `assets-${"0".repeat(32)}`,
        assetsReceiptSize: 1234,
        assetsReceiptSha256: new Uint8Array(32).fill(6),
        assetsArgument: "--assets-dir",
        executable: "/private/gateway",
        guard: new TextEncoder().encode("{}"),
        args: ["", "--stdin-lifeline"],
        environment: [{ name: "UPSTREAM_CREDENTIAL", value: "synthetic-fixture-only" }],
      },
    },
  ],
  [
    "lease_start",
    {
      type: "serviceLeaseStartRequest",
      value: {
        ...query,
        assetsGeneration: `assets-${"0".repeat(32)}`,
        assetsReceiptSize: 1234,
        assetsReceiptSha256: new Uint8Array(32).fill(6),
        assetsArgument: "--assets-dir",
        executable: "/private/gateway",
        guard: new TextEncoder().encode("{}"),
        args: ["--stdin-lifeline"],
        environment: [{ name: "UPSTREAM_CREDENTIAL", value: "synthetic-fixture-only" }],
      },
    },
  ],
  ["lease_started", { type: "serviceLeaseStartResponse", value: response }],
  ["lease_status", { type: "serviceLeaseStatusRequest", value: query }],
  ["lease_status_response", { type: "serviceLeaseStatusResponse", value: response }],
  ["lease_resume", { type: "serviceLeaseResumeRequest", value: query }],
  ["lease_resumed", { type: "serviceLeaseResumeResponse", value: resumed }],
  // Successor Resume #1: the original child is live but the upstream socket is not attached yet.
  [
    "lease_resumed_attaching",
    { type: "serviceLeaseResumeResponse", value: { ...resumed, state: "attaching" } },
  ],
  [
    "lease_stop",
    { type: "serviceLeaseControlRequest", value: { ...query, generation: 2, action: "stop" } },
  ],
  [
    "lease_stopped",
    { type: "serviceLeaseControlResponse", value: { ...response, state: "exited", generation: 2 } },
  ],
  [
    "lease_cancel",
    {
      type: "serviceLeaseControlRequest",
      value: { ...query, generation: 0, action: "cancel-pending" },
    },
  ],
  [
    "lease_cancelled",
    {
      type: "serviceLeaseControlResponse",
      value: {
        ...response,
        state: "cancelled",
        generation: 0,
        originalChildPid: 0,
        originalController: undefined,
        currentController: undefined,
      },
    },
  ],
];
