/**
 * Progress emitter factory for GitManager stacked actions.
 *
 * @module GitManager.progress
 */
import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import type { GitActionProgressEvent, GitStackedAction } from "@bigbud/contracts";

import type { GitRunStackedActionOptions } from "../Services/GitManager.ts";
import type { GitActionProgressPayload } from "./GitManager.types.ts";

export function createProgressEmitter(
  input: { cwd: string; action: GitStackedAction },
  options?: GitRunStackedActionOptions,
) {
  const actionId = options?.actionId ?? randomUUID();
  const reporter = options?.progressReporter;

  const emit = (event: GitActionProgressPayload) =>
    reporter
      ? reporter.publish({
          actionId,
          cwd: input.cwd,
          action: input.action,
          ...event,
        } as GitActionProgressEvent)
      : Effect.void;

  return {
    actionId,
    emit,
  };
}
