import type { OpencodeModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import * as Effect from "effect/Effect";

import type {
  ThreadElevatorSummaryGenerationInput,
  ThreadTitleGenerationInput,
  MetadataTextGenerationAttempt,
} from "../Services/TextGeneration.ts";
import { buildThreadElevatorSummaryPrompt, buildThreadTitlePrompt } from "../Prompts.ts";
import { sanitizeElevatorSummary, sanitizeThreadTitle } from "../Utils.ts";
import { resolveProviderIDForModel } from "../../provider/Layers/Opencode/Adapter.session.helpers.ts";
import type { NativeThreadTitleGenerationDeps } from "./ProviderNativeThreadTitleGeneration.ts";
import {
  extractOpencodeResponseSummary,
  extractOpencodeResponseTitle,
} from "./ProviderNativeThreadTitleGeneration.opencode.ts";

/** One exact auxiliary SDK prompt; shared setup cannot hide a second provider attempt. */
const generate = Effect.fn("generateOpencodeMetadata")(function* (
  deps: NativeThreadTitleGenerationDeps,
  input: {
    readonly cwd: string;
    readonly modelSelection: OpencodeModelSelection;
    readonly metadataAttempt?: MetadataTextGenerationAttempt;
  },
  field: "title" | "summary",
  prompt: string,
) {
  const operation = field === "title" ? "generateThreadTitle" : "generateThreadElevatorSummary";
  const failure = () =>
    new TextGenerationError({ operation, detail: "OpenCode metadata generation failed." });
  if (input.metadataAttempt && !input.modelSelection.subProviderID)
    return yield* new TextGenerationError({
      operation,
      detail: "Exact OpenCode metadata requires a captured subprovider.",
      metadataOutcome: "unavailable",
    });
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        deps.opencodeServerManager.acquire({
          directory: input.cwd,
          ...(input.metadataAttempt
            ? {
                executionTargetId: input.metadataAttempt.executionTarget,
                binaryPath: input.metadataAttempt.providerSettings.opencode.binaryPath,
                provider: "opencode" as const,
              }
            : {}),
        }),
      catch: failure,
    }),
    (handle) =>
      Effect.gen(function* () {
        const client = handle.client;
        const session = yield* Effect.tryPromise({
          try: () =>
            client.session.create({
              title: `Thread ${field === "title" ? "title" : "elevator summary"} generation`,
            }),
          catch: failure,
        });
        if (session.error || !session.data) return yield* failure();
        const providerID =
          input.modelSelection.subProviderID ??
          (yield* Effect.tryPromise({
            try: () => resolveProviderIDForModel(client, input.modelSelection.model),
            catch: failure,
          }));
        if (!providerID) return yield* failure();
        if (input.metadataAttempt) yield* input.metadataAttempt.beforeDispatch();
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            client.session.prompt(
              {
                sessionID: session.data!.id,
                parts: [{ type: "text", text: prompt }],
                format: {
                  type: "json_schema",
                  schema: {
                    type: "object",
                    properties: { [field]: { type: "string" } },
                    required: [field],
                  },
                },
                model: { providerID, modelID: input.modelSelection.model },
                ...(input.modelSelection.options?.reasoningEffort
                  ? { variant: input.modelSelection.options.reasoningEffort }
                  : {}),
                tools: {},
                noReply: false,
                system: `You generate concise thread ${field === "title" ? "titles" : "summaries"}. Return only structured output with a ${field} field.`,
              },
              { signal },
            ),
          catch: failure,
        }).pipe(
          Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => Effect.fail(failure()) }),
        );
        if (response.error || !response.data) return yield* failure();
        const extract =
          field === "title" ? extractOpencodeResponseTitle : extractOpencodeResponseSummary;
        return extract({ info: response.data.info, parts: response.data.parts }) ?? "";
      }),
    (handle) => Effect.sync(() => handle.release()),
  );
});

export const generateOpencodeThreadTitleNative = (
  deps: NativeThreadTitleGenerationDeps,
  input: Omit<ThreadTitleGenerationInput, "modelSelection"> & {
    readonly modelSelection: OpencodeModelSelection;
  },
) =>
  generate(deps, input, "title", buildThreadTitlePrompt(input).prompt).pipe(
    Effect.map((title) => ({ title: sanitizeThreadTitle(title) })),
  );

export const generateOpencodeThreadElevatorSummaryNative = (
  deps: NativeThreadTitleGenerationDeps,
  input: Omit<ThreadElevatorSummaryGenerationInput, "modelSelection"> & {
    readonly modelSelection: OpencodeModelSelection;
  },
) =>
  generate(deps, input, "summary", buildThreadElevatorSummaryPrompt(input).prompt).pipe(
    Effect.map((summary) => ({ summary: sanitizeElevatorSummary(summary) })),
  );
