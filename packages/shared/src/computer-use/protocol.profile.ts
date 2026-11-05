/** Proposed engineering bounds, not measured platform qualifications. */
export const computerUseProtocol = {
  major: 1,
  minor: 0,
  profile: "computer-use-stage1-v1",
  controlFrameBytes: 64 * 1024,
  dataFrameBytes: 25 * 1024 * 1024,
  incompleteFrameMs: 5_000,
  ingressBytes: 32 * 1024 * 1024,
  queuedRequestBytes: 1024 * 1024,
  queuedOperations: 32,
  queuedPerCaller: 4,
  ordinaryControlRequests: 8,
  callerSessions: 32,
  targetRefsPerCaller: 4,
  observations: 32,
  observationBytes: 64 * 1024 * 1024,
  observationTtlMs: 60_000,
  imageBytes: 16 * 1024 * 1024,
  decodedImageBytes: 64 * 1024 * 1024,
  projectedTextBytes: 64 * 1024,
  diagnosticTailBytes: 4 * 1024,
  outcomes: 256,
  outcomeTtlMs: 600_000,
  outcomeMetadataBytes: 8 * 1024 * 1024,
  challengeMs: 100,
  controlLeaseMs: 750,
  guardCheckMs: 100,
  stopTargetAckMs: 250,
  stopHardAckMs: 1_000,
  escalationMs: 250,
  retirementMs: 2_000,
  shutdownMs: 5_000,
  startupMs: 10_000,
  preparationMs: 10_000,
  participationCheckMs: 2_000,
  participationLeaseMs: 10_000,
  participants: 256,
} as const;

export type ComputerUseChannel = "control" | "data";
export const frameMaximum = (channel: ComputerUseChannel): number =>
  channel === "control"
    ? computerUseProtocol.controlFrameBytes
    : computerUseProtocol.dataFrameBytes;
