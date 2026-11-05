import { ServiceMap } from "effect";

export const COMPUTER_USE_STOPPED_BY_USER_MESSAGE = "Computer use was stopped by the user.";

export interface ComputerUseAdmissionShape {
  /** False once a user Stop happened after this action was admitted. */
  readonly isCurrent: () => boolean;
}

/**
 * Fiber-local admission of one computer-use action, set by the activity registry when it admits
 * the action. The Cua driver re-checks it after acquiring its exclusive lock and before every
 * tool call, so an action that was admitted before a Stop (waiting on the lock, or between two
 * driver calls) never reaches the driver afterwards. Without an admission every call is current.
 */
export const ComputerUseAdmission = ServiceMap.Reference<ComputerUseAdmissionShape>(
  "t3/computer-use/ComputerUseAdmission",
  { defaultValue: () => ({ isCurrent: () => true }) },
);
