/** The ONLY channels the restricted computer-use safety renderer can reach. */
export const computerUseSafetyChannels = {
  getStatus: "computer-use-safety:get-status",
  stop: "computer-use-safety:stop",
  acknowledgeWarning: "computer-use-safety:acknowledge-warning",
  openRestrictions: "computer-use-safety:open-restrictions",
} as const;

export const COMPUTER_USE_SAFETY_PARTITION = "computer-use-safety";
export const COMPUTER_USE_NOTICE_ID_MAX_CHARS = 128;

/** Bounded status: no thread, app, window or content details ever cross here. */
export interface ComputerUseSafetyStatus {
  readonly state: "unavailable" | "ready" | "active" | "paused" | "stopping" | "retirement-unknown";
  readonly reason: string | null;
  readonly noticeId: string | null;
  readonly noticeState: "required" | "presented_unconfirmed" | "acked" | null;
}

export interface ComputerUseStopAcknowledgement {
  /** True only when native admission revocation was acknowledged. */
  readonly revoked: boolean;
  readonly reason: string | null;
}
