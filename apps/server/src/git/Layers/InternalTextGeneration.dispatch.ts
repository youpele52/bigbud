import { Effect } from "effect";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { InternalTextGenerationContext } from "../Services/TextGeneration.ts";
import {
  recordThreadTextGenerationStatusRequired,
  type ThreadTextGenerationOperation,
} from "./InternalTextGeneration.status.ts";

/** One ownership mechanism for all metadata jobs; the router, not a caller's settings guess, invokes it. */
export function makeTextGenerationDispatchClaim(
  engine: Parameters<typeof recordThreadTextGenerationStatusRequired>[0],
  threadId: ThreadId,
  operation: ThreadTextGenerationOperation,
  turnId?: string,
) {
  let claimed = false;
  const beforeV2Dispatch: NonNullable<InternalTextGenerationContext["beforeV2Dispatch"]> = (
    selection,
  ) =>
    recordThreadTextGenerationStatusRequired(engine, threadId, operation, "started", {
      uncertaintyProtected: true,
      modelSelection: selection,
      ...(turnId ? { turnId } : {}),
    }).pipe(
      Effect.mapError(
        () =>
          new TextGenerationError({
            operation,
            kind: "provider",
            detail: "Native text-generation ownership could not be persisted; no native dispatch.",
          }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          claimed = true;
        }),
      ),
    );
  return { beforeV2Dispatch, isClaimed: () => claimed };
}
