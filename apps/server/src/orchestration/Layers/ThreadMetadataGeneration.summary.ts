import * as Effect from "effect/Effect";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import type {
  MetadataTextGenerationAttempt,
  TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import { sanitizeElevatorSummary } from "../../git/Utils.ts";
import {
  captureMetadataBase,
  metadataSourceIsCurrent,
  type MetadataCaptureOptions,
  type MetadataSummaryContext,
} from "./ThreadMetadataGeneration.context.ts";
import {
  buildElevatorSummaryTranscript,
  shouldRefreshThreadElevatorSummary,
} from "./ThreadMetadataGeneration.summaryInput.ts";

export const metadataSummaryAdapter = {
  capture(
    thread: OrchestrationThread,
    options: MetadataCaptureOptions & {
      readonly attemptedFrontier: number;
      readonly force?: boolean;
    },
  ): MetadataSummaryContext | null {
    if (thread.archivedAt || thread.deletingAt || thread.deletedAt) return null;
    if (
      !options.force &&
      !shouldRefreshThreadElevatorSummary({
        thread,
        attemptedFrontier: options.attemptedFrontier,
      })
    )
      return null;
    const transcript = buildElevatorSummaryTranscript(thread.messages);
    if (!transcript) return null;
    return {
      ...captureMetadataBase(thread, options),
      operation: "summary",
      previousSummary: thread.elevatorSummary,
      previousMessageCount: thread.elevatorSummaryMessageCount,
      transcript,
    };
  },
  isCurrent(
    context: MetadataSummaryContext,
    thread: OrchestrationThread,
    revision: number,
    cwd: string,
  ) {
    return (
      metadataSourceIsCurrent(context, thread, revision, cwd) &&
      thread.elevatorSummary === context.previousSummary &&
      thread.elevatorSummaryMessageCount === context.previousMessageCount
    );
  },
  generate: Effect.fn("metadataSummary.generate")(function* (
    service: TextGenerationShape,
    context: MetadataSummaryContext,
    metadataAttempt: MetadataTextGenerationAttempt,
  ) {
    const generated = yield* service.generateThreadElevatorSummary({
      cwd: context.workspace.cwd,
      transcript: context.transcript,
      modelSelection: metadataAttempt.selection,
      metadataAttempt,
    });
    const summary = sanitizeElevatorSummary(generated.summary);
    if (!summary)
      return yield* new TextGenerationError({
        operation: "generateThreadElevatorSummary",
        detail: "Generated summary is empty.",
        metadataOutcome: "failed",
      });
    return summary;
  }),
};
