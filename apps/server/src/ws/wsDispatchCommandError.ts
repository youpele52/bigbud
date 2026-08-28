import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Schema } from "effect";

import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
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

  const message = cause instanceof Error ? cause.message : fallbackMessage;
  if (
    Schema.is(OrchestrationCommandInvariantError)(cause) &&
    cause.code === "thread_already_exists"
  ) {
    return new OrchestrationDispatchCommandError({
      message,
      code: cause.code,
    });
  }

  return new OrchestrationDispatchCommandError({ message });
}
