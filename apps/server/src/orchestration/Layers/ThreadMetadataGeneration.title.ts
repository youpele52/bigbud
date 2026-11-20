import * as Effect from "effect/Effect";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { ChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";

import type {
  MetadataTextGenerationAttempt,
  TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import { sanitizeThreadTitle } from "../../git/Utils.ts";
import { shouldAllowAutoTitleReplace } from "../../orchestration-tools/ThreadTitleLock.ts";
import { threadTitleOwner } from "../../orchestration-tools/TerminalThreadTitle.ts";
import { shouldRetryGeneratedThreadTitle } from "./ProviderCommandReactorHelpers.ts";
import {
  captureMetadataBase,
  metadataSourceIsCurrent,
  type MetadataCaptureOptions,
  type MetadataTitleContext,
} from "./ThreadMetadataGeneration.context.ts";

export const metadataTitleAdapter = {
  capture(
    thread: OrchestrationThread,
    options: MetadataCaptureOptions & {
      readonly message: string;
      readonly titleSeed?: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    },
  ): MetadataTitleContext | null {
    const titleSeed = options.titleSeed ?? thread.title;
    if (
      thread.archivedAt ||
      thread.deletingAt ||
      thread.deletedAt ||
      !shouldAllowAutoTitleReplace({
        threadId: thread.id,
        currentTitle: thread.title,
        titleOwner: threadTitleOwner(thread),
        titleSeed,
      })
    )
      return null;
    return {
      ...captureMetadataBase(thread, options),
      operation: "title",
      initialTitle: thread.title,
      titleSeed,
      message: options.message,
      attachments: structuredClone(options.attachments ?? []),
    };
  },
  isCurrent(
    context: MetadataTitleContext,
    thread: OrchestrationThread,
    revision: number,
    cwd: string,
  ) {
    return (
      metadataSourceIsCurrent(context, thread, revision, cwd) &&
      thread.title === context.initialTitle &&
      shouldAllowAutoTitleReplace({
        threadId: thread.id,
        currentTitle: thread.title,
        titleOwner: threadTitleOwner(thread),
        titleSeed: context.titleSeed,
      })
    );
  },
  generate: Effect.fn("metadataTitle.generate")(function* (
    service: TextGenerationShape,
    context: MetadataTitleContext,
    metadataAttempt: MetadataTextGenerationAttempt,
  ) {
    const generated = yield* service.generateThreadTitle({
      cwd: context.workspace.cwd,
      message: context.message,
      titleSeed: context.titleSeed,
      attachments: context.attachments,
      modelSelection: metadataAttempt.selection,
      metadataAttempt,
    });
    const title = sanitizeThreadTitle(generated.title);
    if (shouldRetryGeneratedThreadTitle({ generatedTitle: title, titleSeed: context.titleSeed }))
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Generated title is unusable.",
        metadataOutcome: "failed",
      });
    return title;
  }),
};
