import type { TurnStartFailureClass } from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";

/**
 * Turn-start class of a prompt failure, from the agent process's liveness. An exit observed
 * before dispatch means the turn never started (`session-dead`, recoverable in place). An exit
 * observed only after dispatch leaves the outcome uncertain (`unsafe-to-replay`). Otherwise the
 * adapter leaves classification to the server.
 */
export function promptDispatchFailureClass(input: {
  readonly aliveBeforeDispatch: boolean;
  readonly aliveAfterFailure: boolean;
}): TurnStartFailureClass | undefined {
  if (!input.aliveBeforeDispatch) return "session-dead";
  return input.aliveAfterFailure ? undefined : "unsafe-to-replay";
}
