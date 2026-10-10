import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import {
  isLegacyOpencodeThread,
  isRetiredProvider,
  LEGACY_OPENCODE_READ_ONLY_MESSAGE,
} from "@bigbud/shared/providerLifecycle";
import * as Effect from "effect/Effect";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

const RUNTIME_COMMANDS = new Set<string>([
  "thread.create",
  "thread.turn.start",
  "thread.message.submit",
  "thread.queued-prompt.flush",
  "thread.turn.steer",
  "thread.turn.interrupt",
  "thread.session.stop",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.shell.run",
  "thread.checkpoint.revert",
  "thread.path-checkpoint.capture",
  "thread.path-checkpoint.restore",
]);

/** Admission only: historical event replay never invokes this policy or rewrites IDs. */
export function requireActiveOpencodeIntegration(
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const thread =
    "threadId" in command
      ? readModel.threads.find((candidate) => candidate.id === command.threadId)
      : undefined;
  const selectedLegacy =
    ("modelSelection" in command && isRetiredProvider(command.modelSelection?.provider)) ||
    ("defaultModelSelection" in command &&
      isRetiredProvider(command.defaultModelSelection?.provider));
  const forbidden =
    selectedLegacy ||
    (isLegacyOpencodeThread(thread) &&
      (RUNTIME_COMMANDS.has(command.type) ||
        (command.type === "thread.meta.update" && command.modelSelection !== undefined)));
  return forbidden
    ? Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: LEGACY_OPENCODE_READ_ONLY_MESSAGE,
        }),
      )
    : Effect.void;
}
