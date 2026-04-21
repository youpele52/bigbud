/**
 * Orchestration command decider — thin dispatcher.
 *
 * Routes each command to either `decideProjectCommand` or
 * `decideThreadCommand` based on the command's aggregate kind.
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { decideProjectCommand } from "./deciderProjects.ts";
import { decideThreadCommand } from "./deciderThreads.ts";

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  if (
    command.type === "project.create" ||
    command.type === "project.meta.update" ||
    command.type === "project.delete"
  ) {
    return yield* decideProjectCommand({ command, readModel });
  }

  return yield* decideThreadCommand({ command, readModel });
});
