import { TextGenerationError, type PiModelSelection } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import { createPiRpcProcess } from "../../provider/Layers/Pi/RpcProcess.ts";
import type { PiRpcStdoutEvent } from "../../provider/Layers/Pi/RpcProcess.ts";
import { resolveProviderRuntimeTarget } from "../../provider-runtime/providerRuntimeTarget.ts";
import { resolveWorkspaceTarget } from "../../workspace-target/workspaceTarget.ts";
import type { ThreadTitleGenerationInput } from "../Services/TextGeneration.ts";
import { limitSection, sanitizeThreadTitle } from "../Utils.ts";

import type { NativeThreadTitleGenerationDeps } from "./ProviderNativeThreadTitleGeneration.ts";

const PI_TIMEOUT_MS = 60_000;

type PiThreadTitleGenerationInput = Omit<ThreadTitleGenerationInput, "modelSelection"> & {
  readonly modelSelection: PiModelSelection;
};

const PI_TITLE_PROMPT_PREFIX = [
  "Write a concise thread title for a coding conversation.",
  "Return plain text only - no JSON, no quotes, no prefixes, no trailing punctuation.",
  "Keep it short and specific (3-8 words).",
  "",
  "User message:",
].join("\n");

function buildPiThreadTitlePrompt(input: {
  readonly message: string;
  readonly attachments?: ThreadTitleGenerationInput["attachments"];
}): string {
  return [
    PI_TITLE_PROMPT_PREFIX,
    limitSection(input.message, 8_000),
    ...(input.attachments && input.attachments.length > 0
      ? [
          "",
          "Attachment metadata:",
          limitSection(
            input.attachments
              .filter((a) => a.type !== "thread")
              .map((a) => `- ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes)`)
              .join("\n"),
            4_000,
          ),
        ]
      : []),
  ].join("\n");
}

function collectPiThreadTitle(
  rpcProcess: Awaited<ReturnType<typeof createPiRpcProcess>>,
  prompt: string,
) {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        let collectedText = "";
        let settled = false;
        // Only collect assistant text deltas, not echoed user content.
        let inAssistantMessage = false;

        const unsubscribe = rpcProcess.subscribe((message) => {
          if (!("type" in message)) return;
          const event = message as PiRpcStdoutEvent;

          if (event.type === "message_start") {
            const role =
              typeof (event as { type: "message_start"; message: Record<string, unknown> }).message
                .role === "string"
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
}

/**
 * Generates a thread title using the Pi RPC process directly.
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

    const rpcProcess = yield* Effect.tryPromise({
      try: () =>
        createPiRpcProcess({
          binaryPath: piSettings.binaryPath,
          providerRuntimeTarget: resolveProviderRuntimeTarget({ executionTargetId: "local" }),
          workspaceTarget: resolveWorkspaceTarget({
            executionTargetId: "local",
            cwd: input.cwd,
          }),
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
    const title = yield* collectPiThreadTitle(rpcProcess, buildPiThreadTitlePrompt(input)).pipe(
      Effect.ensuring(stopProcess),
    );

    return {
      title: sanitizeThreadTitle(title.trim()),
    };
  });
