import type { PermissionRequestResult } from "@github/copilot-sdk";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { CopilotModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type {
  MetadataTextGenerationAttempt,
  ThreadElevatorSummaryGenerationInput,
  ThreadTitleGenerationInput,
} from "../Services/TextGeneration.ts";
import { buildThreadElevatorSummaryPrompt } from "../Prompts.ts";
import { sanitizeElevatorSummary, sanitizeThreadTitle } from "../Utils.ts";
import { createLeasedCopilotClient } from "../../provider/Layers/Copilot/Runtime.client.ts";
import { buildCopilotThreadTitlePrompt } from "./ProviderNativeThreadTitleGeneration.copilotPrompt.ts";
import type { OpencodeServerManagerShape } from "../../provider/Services/Opencode/ServerManager.ts";
import { extractTitleFromTextCandidate } from "./ProviderNativeThreadTitleGeneration.opencode.ts";

export { generatePiThreadTitleNative } from "./ProviderNativeThreadTitleGeneration.pi.ts";
export {
  generateOpencodeThreadTitleNative,
  generateOpencodeThreadElevatorSummaryNative,
} from "./ProviderNativeThreadTitleGeneration.opencodeRunner.ts";

export interface NativeThreadTitleGenerationDeps {
  readonly serverSettingsService: ServerSettingsShape;
  readonly opencodeServerManager: OpencodeServerManagerShape;
}

const denyAllPermissions = (): PermissionRequestResult => ({ kind: "reject" });
/** Auxiliary one-shot generation, not isolated native metadata maintenance. */
const generateCopilotMetadata = Effect.fn("generateCopilotMetadata")(function* (
  deps: NativeThreadTitleGenerationDeps,
  input: {
    readonly cwd: string;
    readonly modelSelection: CopilotModelSelection;
    readonly metadataAttempt?: MetadataTextGenerationAttempt;
  },
  field: "title" | "summary",
  prompt: string,
) {
  const operation = field === "title" ? "generateThreadTitle" : "generateThreadElevatorSummary";
  const failure = () =>
    new TextGenerationError({
      operation,
      detail: "GitHub Copilot metadata generation failed.",
    });
  const copilotSettings =
    input.metadataAttempt?.providerSettings.copilot ??
    (yield* deps.serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.copilot),
      Effect.catch(() => Effect.void),
    ));
  const response = yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        createLeasedCopilotClient({
          binaryPath: copilotSettings?.binaryPath ?? "copilot",
          workingDirectory: input.cwd,
        }),
      catch: failure,
    }),
    (client) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () =>
            client.createSession({
              workingDirectory: input.cwd,
              model: input.modelSelection.model,
              ...(input.modelSelection.options?.reasoningEffort
                ? { reasoningEffort: input.modelSelection.options.reasoningEffort }
                : {}),
              availableTools: [],
              onPermissionRequest: denyAllPermissions,
              streaming: false,
              systemMessage: {
                mode: "replace",
                content:
                  field === "title"
                    ? "You generate concise thread titles. Never use tools. Return only the title text."
                    : "You generate concise elevator summaries. Never use tools. Return only a JSON object with a summary field.",
              },
            }),
          catch: failure,
        }),
        (session) =>
          Effect.gen(function* () {
            if (input.metadataAttempt) yield* input.metadataAttempt.beforeDispatch();
            return yield* Effect.tryPromise({
              try: () => session.sendAndWait({ prompt, mode: "immediate" }, 60_000),
              catch: failure,
            });
          }),
        (session) => Effect.promise(() => session.disconnect().catch(() => undefined)),
      ),
    (client) => Effect.promise(() => client.stop().catch(() => [])),
  );
  return response?.data.content ?? "";
});

export const generateCopilotThreadTitleNative = (
  deps: NativeThreadTitleGenerationDeps,
  input: Omit<ThreadTitleGenerationInput, "modelSelection"> & {
    readonly modelSelection: CopilotModelSelection;
  },
) =>
  generateCopilotMetadata(deps, input, "title", buildCopilotThreadTitlePrompt(input)).pipe(
    Effect.map((text) => ({
      title: sanitizeThreadTitle(extractTitleFromTextCandidate(text) ?? text),
    })),
  );

export const generateCopilotThreadElevatorSummaryNative = (
  deps: NativeThreadTitleGenerationDeps,
  input: Omit<ThreadElevatorSummaryGenerationInput, "modelSelection"> & {
    readonly modelSelection: CopilotModelSelection;
  },
) => {
  const { prompt, outputSchema } = buildThreadElevatorSummaryPrompt(input);
  return generateCopilotMetadata(deps, input, "summary", prompt).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(outputSchema))(text).pipe(
        Effect.mapError(
          () =>
            new TextGenerationError({
              operation: "generateThreadElevatorSummary",
              detail: "GitHub Copilot returned an invalid elevator summary.",
              metadataOutcome: "failed",
            }),
        ),
      ),
    ),
    Effect.map(({ summary }) => ({ summary: sanitizeElevatorSummary(summary) })),
  );
};
