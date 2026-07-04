import {
  CopilotClient,
  type CopilotClientOptions,
  type PermissionRequestResult,
} from "@github/copilot-sdk";
import {
  TextGenerationError,
  type CopilotModelSelection,
  type OpencodeModelSelection,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { ServerSettingsShape } from "../../ws/serverSettings.ts";

import type { ThreadTitleGenerationInput } from "../Services/TextGeneration.ts";
import { buildThreadTitlePrompt } from "../Prompts.ts";
import { limitSection, sanitizeThreadTitle } from "../Utils.ts";
import {
  makeCliRuntimeConnection,
  makeNodeWrapperCliPath,
} from "../../provider/Layers/Copilot/Adapter.types.ts";
import { resolveProviderIDForModel } from "../../provider/Layers/Opencode/Adapter.session.helpers.ts";
import type { OpencodeServerManagerShape } from "../../provider/Services/Opencode/ServerManager.ts";
import {
  extractOpencodeResponseTitle,
  extractTitleFromTextCandidate,
} from "./ProviderNativeThreadTitleGeneration.opencode.ts";

export { generatePiThreadTitleNative } from "./ProviderNativeThreadTitleGeneration.pi.ts";

const COPILOT_TIMEOUT_MS = 60_000;
const OPENCODE_TIMEOUT_MS = 60_000;

type CopilotThreadTitleGenerationInput = Omit<ThreadTitleGenerationInput, "modelSelection"> & {
  readonly modelSelection: CopilotModelSelection;
};

type OpencodeThreadTitleGenerationInput = Omit<ThreadTitleGenerationInput, "modelSelection"> & {
  readonly modelSelection: OpencodeModelSelection;
};

export interface NativeThreadTitleGenerationDeps {
  readonly serverSettingsService: ServerSettingsShape;
  readonly opencodeServerManager: OpencodeServerManagerShape;
}

const denyAllPermissions = (): PermissionRequestResult => ({
  kind: "reject",
});

function buildCopilotThreadTitlePrompt(input: {
  readonly message: string;
  readonly attachments?: ThreadTitleGenerationInput["attachments"];
}): string {
  const attachmentLines = (input.attachments ?? [])
    .filter((attachment) => attachment.type !== "thread")
    .map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    );
  const sections = [
    "Write a concise thread title for a coding conversation.",
    "Return plain text only.",
    "Do not return JSON.",
    "Do not wrap the title in quotes.",
    "Do not include prefixes or trailing punctuation.",
    "Keep it short and specific (3-8 words).",
    "",
    "User message:",
    limitSection(input.message, 8_000),
  ];

  if (attachmentLines.length > 0) {
    sections.push("", "Attachment metadata:", limitSection(attachmentLines.join("\n"), 4_000));
  }

  return sections.join("\n");
}

export const generateCopilotThreadTitleNative = (
  deps: NativeThreadTitleGenerationDeps,
  input: CopilotThreadTitleGenerationInput,
) =>
  Effect.gen(function* () {
    const copilotSettings = yield* deps.serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.copilot),
      Effect.catch(() => Effect.void),
    );
    const binaryPath = copilotSettings?.binaryPath;
    const useCustomBinary = binaryPath !== undefined && binaryPath !== "copilot";
    const resolvedCliPath = useCustomBinary ? binaryPath : makeNodeWrapperCliPath();
    const connection = makeCliRuntimeConnection(resolvedCliPath);
    const clientOptions: CopilotClientOptions = {
      ...(connection ? { connection } : {}),
      ...(input.cwd ? { workingDirectory: input.cwd } : {}),
      logLevel: "error",
    };

    const prompt = buildCopilotThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const client = new CopilotClient(clientOptions);

    const response = yield* Effect.tryPromise({
      try: async () => {
        const session = await client.createSession({
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
              "You generate concise thread titles. Never use tools. Return only the title text.",
          },
        });

        try {
          return await session.sendAndWait({ prompt, mode: "immediate" }, COPILOT_TIMEOUT_MS);
        } finally {
          await session.disconnect().catch(() => undefined);
          await client.stop().catch(() => []);
        }
      },
      catch: (cause) =>
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail:
            cause instanceof Error
              ? `GitHub Copilot thread title generation failed: ${cause.message}`
              : "GitHub Copilot thread title generation failed.",
          cause,
        }),
    });

    return {
      title: sanitizeThreadTitle(
        extractTitleFromTextCandidate(response?.data.content ?? "") ?? response?.data.content ?? "",
      ),
    };
  });

export const generateOpencodeThreadTitleNative = (
  deps: NativeThreadTitleGenerationDeps,
  input: OpencodeThreadTitleGenerationInput,
) =>
  Effect.gen(function* () {
    const serverHandle = yield* Effect.tryPromise({
      try: () => deps.opencodeServerManager.acquire({ directory: input.cwd }),
      catch: (cause) =>
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail:
            cause instanceof Error
              ? `OpenCode server startup failed: ${cause.message}`
              : "OpenCode server startup failed.",
          cause,
        }),
    });

    const client = serverHandle.client;
    const { prompt } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    try {
      const sessionResp = yield* Effect.tryPromise({
        try: () =>
          client.session.create({
            title: "Thread title generation",
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail:
              cause instanceof Error
                ? `OpenCode session creation failed: ${cause.message}`
                : "OpenCode session creation failed.",
            cause,
          }),
      });

      if (sessionResp.error || !sessionResp.data) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: `OpenCode session creation failed: ${String(sessionResp.error)}`,
        });
      }

      const sessionID = sessionResp.data.id;
      const providerID =
        input.modelSelection.subProviderID ??
        (yield* Effect.tryPromise({
          try: () => resolveProviderIDForModel(client, input.modelSelection.model),
          catch: () => undefined as never,
        }).pipe(Effect.orElseSucceed(() => undefined)));

      if (!providerID) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: `Unable to resolve OpenCode provider for model '${input.modelSelection.model}'.`,
        });
      }

      const promptResp = yield* Effect.tryPromise({
        try: () =>
          client.session.prompt({
            sessionID,
            parts: [{ type: "text", text: prompt }],
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
                required: ["title"],
              },
            },
            model: {
              providerID,
              modelID: input.modelSelection.model,
            },
            tools: {},
            noReply: false,
            system:
              "You generate concise thread titles. Return only structured output with a title field.",
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail:
              cause instanceof Error
                ? `OpenCode thread title generation failed: ${cause.message}`
                : "OpenCode thread title generation failed.",
            cause,
          }),
      }).pipe(
        Effect.timeoutOption(OPENCODE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: "OpenCode thread title generation timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      if (promptResp.error || !promptResp.data) {
        return yield* new TextGenerationError({
          operation: "generateThreadTitle",
          detail: `OpenCode thread title generation failed: ${String(promptResp.error)}`,
        });
      }

      return {
        title: sanitizeThreadTitle(
          extractOpencodeResponseTitle({
            info: promptResp.data.info,
            parts: promptResp.data.parts,
          }) ?? "",
        ),
      };
    } finally {
      serverHandle.release();
    }
  });
