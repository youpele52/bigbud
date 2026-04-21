import {
  CopilotClient,
  type CopilotClientOptions,
  type PermissionRequestResult,
} from "@github/copilot-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
  TextGenerationError,
  type CopilotModelSelection,
  type OpencodeModelSelection,
  type PiModelSelection,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";

import { createPiRpcProcess } from "../../provider/Layers/PiRpcProcess.ts";
import type { PiRpcStdoutEvent } from "../../provider/Layers/PiRpcProcess.ts";
import type { ServerSettingsShape } from "../../ws/serverSettings.ts";

import type { ThreadTitleGenerationInput } from "../Services/TextGeneration.ts";
import { buildThreadTitlePrompt } from "../Prompts.ts";
import { limitSection, sanitizeThreadTitle } from "../Utils.ts";
import { makeNodeWrapperCliPath } from "../../provider/Layers/CopilotAdapter.types.ts";
import { resolveProviderIDForModel } from "../../provider/Layers/OpencodeAdapter.session.helpers.ts";
import { withOpencodeDirectory } from "../../provider/Layers/OpencodeAdapter.stream.ts";
import type { OpencodeServerManagerShape } from "../../provider/Services/OpencodeServerManager.ts";

const COPILOT_TIMEOUT_MS = 60_000;
const OPENCODE_TIMEOUT_MS = 60_000;
const PI_TIMEOUT_MS = 60_000;

type CopilotThreadTitleGenerationInput = Omit<ThreadTitleGenerationInput, "modelSelection"> & {
  readonly modelSelection: CopilotModelSelection;
};

type OpencodeThreadTitleGenerationInput = Omit<ThreadTitleGenerationInput, "modelSelection"> & {
  readonly modelSelection: OpencodeModelSelection;
};

type PiThreadTitleGenerationInput = Omit<ThreadTitleGenerationInput, "modelSelection"> & {
  readonly modelSelection: PiModelSelection;
};

export interface NativeThreadTitleGenerationDeps {
  readonly serverSettingsService: ServerSettingsShape;
  readonly opencodeServerManager: OpencodeServerManagerShape;
}

const denyAllPermissions = (): PermissionRequestResult => ({
  kind: "denied-by-permission-request-hook",
});

function extractOpencodeStructuredTitle(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("title" in value)) {
    return null;
  }
  const title = value.title;
  return typeof title === "string" ? title : null;
}

function extractTitleFromTextCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    const parsed = JSON.parse(candidate);
    return extractOpencodeStructuredTitle(parsed);
  } catch {
    // Fall through to loose parsing for quasi-JSON responses.
  }

  const quotedMatch = candidate.match(/['"]?title['"]?\s*:\s*['"]([^'"]+)['"]/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  const bareMatch = candidate.match(/['"]?title['"]?\s*:\s*([^,}\n]+)/i);
  if (bareMatch?.[1]) {
    return bareMatch[1].trim();
  }

  return null;
}

function extractOpencodeTextTitle(parts: ReadonlyArray<unknown>): string | null {
  for (const part of parts) {
    if (typeof part !== "object" || part === null || !("type" in part) || !("text" in part)) {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
      return extractTitleFromTextCandidate(part.text) ?? part.text;
    }
  }
  return null;
}

function buildCopilotThreadTitlePrompt(input: {
  readonly message: string;
  readonly attachments?: ThreadTitleGenerationInput["attachments"];
}): string {
  const attachmentLines = (input.attachments ?? []).map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
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
    const clientOptions: CopilotClientOptions = {
      ...(resolvedCliPath !== undefined ? { cliPath: resolvedCliPath } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
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
      try: () => deps.opencodeServerManager.acquire(),
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

    const client = createOpencodeClient({ baseUrl: serverHandle.url });
    const { prompt } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    try {
      const sessionResp = yield* Effect.tryPromise({
        try: () =>
          client.session.create(
            withOpencodeDirectory(input.cwd, {
              body: { title: "Thread title generation" },
            }),
          ),
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
          try: () => resolveProviderIDForModel(client, input.cwd, input.modelSelection.model),
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
          client.session.prompt(
            withOpencodeDirectory(input.cwd, {
              path: { id: sessionID },
              body: {
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
              },
            }),
          ),
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

      const structuredTitle =
        "structured" in promptResp.data.info
          ? extractOpencodeStructuredTitle(promptResp.data.info.structured)
          : null;
      const fallbackTextTitle = extractOpencodeTextTitle(promptResp.data.parts);

      return {
        title: sanitizeThreadTitle(structuredTitle ?? fallbackTextTitle ?? ""),
      };
    } finally {
      serverHandle.release();
    }
  });

const PI_TITLE_PROMPT_PREFIX = [
  "Write a concise thread title for a coding conversation.",
  "Return plain text only — no JSON, no quotes, no prefixes, no trailing punctuation.",
  "Keep it short and specific (3-8 words).",
  "",
  "User message:",
].join("\n");

/**
 * Generates a thread title using the Pi RPC process directly.
 * Spawns a temporary Pi process, sends the title-generation prompt,
 * collects streamed text, then stops the process.
 */
export const generatePiThreadTitleNative = (
  deps: NativeThreadTitleGenerationDeps,
  input: PiThreadTitleGenerationInput,
) =>
  Effect.gen(function* () {
    const piSettings = yield* deps.serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.pi),
      Effect.mapError(
        () =>
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: "Failed to read Pi settings.",
          }),
      ),
    );

    const prompt = [
      PI_TITLE_PROMPT_PREFIX,
      limitSection(input.message, 8_000),
      ...(input.attachments && input.attachments.length > 0
        ? [
            "",
            "Attachment metadata:",
            limitSection(
              input.attachments
                .map((a) => `- ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes)`)
                .join("\n"),
              4_000,
            ),
          ]
        : []),
    ].join("\n");

    const rpcProcess = yield* Effect.tryPromise({
      try: () =>
        createPiRpcProcess({
          binaryPath: piSettings.binaryPath,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          env: process.env,
        }),
      catch: (cause) =>
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail:
            cause instanceof Error
              ? `Failed to start Pi process for thread title generation: ${cause.message}`
              : "Failed to start Pi process for thread title generation.",
          cause,
        }),
    });

    const stopProcess = Effect.promise(() => rpcProcess.stop().catch(() => undefined));

    const generateTitle = Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          let collectedText = "";
          let settled = false;
          // Track whether we are inside an assistant message so we only collect
          // text deltas from Pi's reply — not from any user-message echoes.
          let inAssistantMessage = false;

          const unsubscribe = rpcProcess.subscribe((message) => {
            if (!("type" in message)) return;
            const event = message as PiRpcStdoutEvent;

            if (event.type === "message_start") {
              const role =
                typeof (event as { type: "message_start"; message: Record<string, unknown> })
                  .message.role === "string"
                  ? (event as { type: "message_start"; message: Record<string, unknown> }).message
                      .role
                  : undefined;
              inAssistantMessage = role === "assistant";
            } else if (
              event.type === "message_update" &&
              "assistantMessageEvent" in event &&
              event.assistantMessageEvent?.type === "text_delta"
            ) {
              if (inAssistantMessage) {
                collectedText += event.assistantMessageEvent.delta;
              }
            } else if (event.type === "message_end") {
              const msg = (event as { type: "message_end"; message: Record<string, unknown> })
                .message;
              const role = typeof msg.role === "string" ? msg.role : undefined;
              if (role === "assistant") {
                inAssistantMessage = false;
                // Fallback: extract text from final message if streaming deltas weren't received
                if (collectedText.length === 0) {
                  const content = msg.content;
                  if (typeof content === "string" && content.trim().length > 0) {
                    collectedText = content;
                  } else if (Array.isArray(content)) {
                    for (const part of content) {
                      if (
                        part &&
                        typeof part === "object" &&
                        "type" in part &&
                        part.type === "text" &&
                        "text" in part &&
                        typeof part.text === "string"
                      ) {
                        collectedText += part.text;
                      }
                    }
                  }
                }
              }
            } else if (event.type === "turn_end" || event.type === "agent_end") {
              if (!settled) {
                settled = true;
                unsubscribe();
                if (collectedText.trim().length === 0) {
                  reject(new Error("Pi thread title generation produced an empty response."));
                } else {
                  resolve(collectedText);
                }
              }
            }
          });

          // Use write() instead of request() so the promise doesn't resolve early
          // on the RPC acknowledgment — we wait for turn_end above instead.
          rpcProcess.write({ type: "prompt", message: prompt }).catch((err: unknown) => {
            if (!settled) {
              settled = true;
              unsubscribe();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        }),
      catch: (cause) =>
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail:
            cause instanceof Error
              ? `Pi thread title generation failed: ${cause.message}`
              : "Pi thread title generation failed.",
          cause,
        }),
    }).pipe(
      Effect.timeoutOption(PI_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "Pi thread title generation timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const title = yield* generateTitle.pipe(Effect.ensuring(stopProcess));

    return {
      title: sanitizeThreadTitle(title.trim()),
    };
  });
