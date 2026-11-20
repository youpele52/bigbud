import type { ChatAttachment } from "@bigbud/contracts/orchestration/orchestration.attachments.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

interface Input {
  readonly threadId: ThreadId;
  readonly cwd?: string;
  readonly messageText: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly titleSeed?: string;
  readonly retry?: boolean;
  readonly retryKey?: string;
}

/** Requests durable work only. No legacy auxiliary stages or automatic manual-rename writes. */
export const maybeGenerateThreadTitleForFirstTurn = (services: SessionOpServices) =>
  Effect.fn("maybeGenerateThreadTitleForFirstTurn")(function* (input: Input) {
    if (!services.metadataGeneration) {
      yield* Effect.logWarning("Durable metadata generation is unavailable.");
      return;
    }
    yield* services.metadataGeneration
      .title({
        threadId: input.threadId,
        messageText: input.messageText,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
        ...(input.retryKey !== undefined ? { retryKey: input.retryKey } : {}),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not confirm durable title generation request."),
        ),
      );
  });
