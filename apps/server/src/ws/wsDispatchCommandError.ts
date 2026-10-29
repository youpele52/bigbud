import { QueueDecisionReason } from "@bigbud/contracts/orchestration/orchestration.queueDecision.ts";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Schema } from "effect";

import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { CommandAdmissionError } from "../command-admission/CommandAdmission.ts";

export function toDispatchCommandError(
  cause: unknown,
  fallbackMessage: string,
): OrchestrationDispatchCommandError {
  if (Schema.is(OrchestrationDispatchCommandError)(cause)) {
    return cause;
  }

  if (cause instanceof CommandAdmissionError) {
    return new OrchestrationDispatchCommandError({
      message: cause.message,
      code: cause.code,
      retryAfterMs: cause.retryAfterMs,
    });
  }

  if (Schema.is(OrchestrationCommandIdConflictError)(cause)) {
    return new OrchestrationDispatchCommandError({
      message: cause.message,
      code: "command_id_conflict",
    });
  }

  if (Schema.is(OrchestrationCommandPreviouslyRejectedError)(cause) && cause.queueReason) {
    return new OrchestrationDispatchCommandError({
      message: cause.message,
      code: cause.queueReason,
    });
  }
  const message = cause instanceof Error ? cause.message : fallbackMessage;
  if (
    Schema.is(OrchestrationCommandInvariantError)(cause) &&
    (Schema.is(QueueDecisionReason)(cause.code) ||
      cause.code === "thread_already_exists" ||
      cause.code === "prompt_queue_full" ||
      cause.code === "prompt_not_queueable")
  ) {
    return new OrchestrationDispatchCommandError({
      message,
      code: cause.code,
    });
  }

  return new OrchestrationDispatchCommandError({ message });
}
