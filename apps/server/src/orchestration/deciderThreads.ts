/**
 * Decider cases for thread-scoped commands.
 *
 * Handles all thread.* commands.
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  type ThreadLifecycleCommand,
  decideThreadLifecycleCommand,
} from "./deciderThreads.lifecycle.ts";
import { type ThreadTurnCommand, decideThreadTurnCommand } from "./deciderThreads.turn.ts";

const LIFECYCLE_TYPES = new Set([
  "thread.create",
  "thread.delete",
  "thread.archive",
  "thread.unarchive",
  "thread.meta.update",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
]);

export const decideThreadCommand = Effect.fn("decideThreadCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: Exclude<
    OrchestrationCommand,
    { type: "project.create" | "project.meta.update" | "project.delete" }
  >;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  if (LIFECYCLE_TYPES.has(command.type)) {
    return yield* decideThreadLifecycleCommand({
      command: command as ThreadLifecycleCommand,
      readModel,
    });
  }
  return yield* decideThreadTurnCommand({
    command: command as ThreadTurnCommand,
    readModel,
  });
});
