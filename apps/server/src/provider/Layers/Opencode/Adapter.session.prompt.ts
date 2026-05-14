import type { OpencodeClient, OutputFormat } from "@opencode-ai/sdk/v2";

const OPENCODE_PROMPT_REQUEST_TIMEOUT_MS = 15_000;
const OPENCODE_PROMPT_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const OPENCODE_PROMPT_POLL_INTERVAL_MS = 1_000;

export type PromptResultInfo = {
  readonly id: string;
  readonly role: string;
  readonly parentID?: string;
  readonly modelID?: string;
  readonly providerID?: string;
  readonly structured?: unknown;
  readonly finish?: string;
  readonly error?: {
    readonly name?: string;
    readonly data?: {
      readonly message?: string;
      readonly responseBody?: string;
      readonly statusCode?: number;
    };
  };
  readonly time?: {
    readonly created?: number;
    readonly completed?: number;
  };
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: {
      readonly read: number;
      readonly write: number;
    };
  };
};

export type PromptResultPart = {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly tool?: string;
  readonly state?: {
    readonly status?: string;
    readonly output?: string;
    readonly error?: string;
    readonly title?: string;
    readonly input?: unknown;
  };
  readonly metadata?: Record<string, unknown>;
};

export type OpencodePromptInputPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "file";
      readonly mime: string;
      readonly filename: string;
      readonly url: string;
    };

export type StreamedPromptDelta = {
  readonly itemId: string;
  readonly streamKind: "assistant_text" | "reasoning_text";
  readonly delta: string;
};

type PromptMessageSnapshot = {
  readonly info: PromptResultInfo;
  readonly parts?: ReadonlyArray<PromptResultPart>;
};

type AssistantReply = {
  readonly info: PromptResultInfo;
  readonly parts: ReadonlyArray<PromptResultPart>;
};

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`OpenCode request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  return run(controller.signal).finally(() => {
    clearTimeout(timeout);
  });
}

function findLatestCompletedAssistantReply(
  messages: ReadonlyArray<PromptMessageSnapshot>,
): AssistantReply | undefined {
  const completedAssistantMessages = messages.filter(
    (message) => message.info.role === "assistant" && message.info.time?.completed,
  );

  if (completedAssistantMessages.length === 0) {
    return undefined;
  }

  const assistantMessage = completedAssistantMessages.reduce((latest, message) => {
    const latestCompletedAt = latest.info.time?.completed ?? 0;
    const messageCompletedAt = message.info.time?.completed ?? 0;
    return messageCompletedAt > latestCompletedAt ? message : latest;
  });

  return {
    info: assistantMessage.info,
    parts: assistantMessage.parts ?? [],
  };
}

function findLatestAssistantReply(
  messages: ReadonlyArray<PromptMessageSnapshot>,
): AssistantReply | undefined {
  const assistantMessages = messages.filter((message) => message.info.role === "assistant");

  if (assistantMessages.length === 0) {
    return undefined;
  }

  const assistantMessage = assistantMessages.reduce((latest, message) => {
    const latestCreatedAt = latest.info.time?.completed ?? latest.info.time?.created ?? 0;
    const messageCreatedAt = message.info.time?.completed ?? message.info.time?.created ?? 0;
    return messageCreatedAt > latestCreatedAt ? message : latest;
  });

  return {
    info: assistantMessage.info,
    parts: assistantMessage.parts ?? [],
  };
}

function toStreamKind(part: PromptResultPart): StreamedPromptDelta["streamKind"] | undefined {
  if (part.type === "text") {
    return "assistant_text";
  }
  if (part.type === "reasoning") {
    return "reasoning_text";
  }
  return undefined;
}

function diffPartText(previousText: string | undefined, nextText: string): string {
  if (!previousText) {
    return nextText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText.slice(previousText.length);
  }
  return nextText;
}

function collectStreamedDeltas(input: {
  readonly parts: ReadonlyArray<PromptResultPart>;
  readonly emittedTextByPartId: Map<string, string>;
}): ReadonlyArray<StreamedPromptDelta> {
  const deltas: StreamedPromptDelta[] = [];

  for (const part of input.parts) {
    const streamKind = toStreamKind(part);
    const nextText = typeof part.text === "string" ? part.text : undefined;
    if (!streamKind || !nextText || nextText.length === 0) {
      continue;
    }

    const previousText = input.emittedTextByPartId.get(part.id);
    const delta = diffPartText(previousText, nextText);
    input.emittedTextByPartId.set(part.id, nextText);

    if (delta.length === 0) {
      continue;
    }

    deltas.push({
      itemId: part.id,
      streamKind,
      delta,
    });
  }

  return deltas;
}

async function fetchSessionMessages(
  client: OpencodeClient,
  sessionID: string,
): Promise<ReadonlyArray<PromptMessageSnapshot>> {
  const messagesResponse = await withTimeout(
    (signal) =>
      client.session.messages(
        {
          sessionID,
          limit: 20,
        },
        { signal },
      ),
    OPENCODE_PROMPT_REQUEST_TIMEOUT_MS,
  );

  if (messagesResponse.error) {
    throw messagesResponse.error;
  }

  return (messagesResponse.data ?? []) as ReadonlyArray<PromptMessageSnapshot>;
}

export async function sendPromptAsyncAndWaitForCompletion(input: {
  readonly client: OpencodeClient;
  readonly sessionID: string;
  readonly parts: ReadonlyArray<OpencodePromptInputPart>;
  readonly system: string;
  readonly format?: OutputFormat;
  readonly model?: {
    readonly providerID: string;
    readonly modelID: string;
  };
  readonly tools?: Record<string, boolean>;
  readonly noReply?: boolean;
  readonly turnStillActive: () => boolean;
  readonly onDelta?: (delta: StreamedPromptDelta) => Promise<void>;
}): Promise<AssistantReply | undefined> {
  const latestCompletedAssistantBeforePrompt = findLatestCompletedAssistantReply(
    await fetchSessionMessages(input.client, input.sessionID),
  );
  const emittedTextByPartId = new Map<string, string>();

  const promptAsyncResponse = await withTimeout(
    (signal) =>
      input.client.session.promptAsync(
        {
          sessionID: input.sessionID,
          parts: [...input.parts],
          system: input.system,
          ...(input.format ? { format: input.format } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.tools ? { tools: input.tools } : {}),
          ...(input.noReply !== undefined ? { noReply: input.noReply } : {}),
        },
        { signal },
      ),
    OPENCODE_PROMPT_REQUEST_TIMEOUT_MS,
  );

  if (promptAsyncResponse.error) {
    throw promptAsyncResponse.error;
  }

  const startedAt = Date.now();
  while (input.turnStillActive()) {
    const messages = await fetchSessionMessages(input.client, input.sessionID);
    const latestAssistantReply = findLatestAssistantReply(messages);

    if (
      latestAssistantReply &&
      latestAssistantReply.info.id !== latestCompletedAssistantBeforePrompt?.info.id
    ) {
      const deltas = collectStreamedDeltas({
        parts: latestAssistantReply.parts,
        emittedTextByPartId,
      });
      for (const delta of deltas) {
        await input.onDelta?.(delta);
      }

      if (latestAssistantReply.info.time?.completed) {
        return latestAssistantReply;
      }
    }

    if (Date.now() - startedAt >= OPENCODE_PROMPT_COMPLETION_TIMEOUT_MS) {
      throw new Error(
        `OpenCode prompt did not complete within ${OPENCODE_PROMPT_COMPLETION_TIMEOUT_MS}ms.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, OPENCODE_PROMPT_POLL_INTERVAL_MS));
  }

  return undefined;
}

export function isOpencodeTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /fetch failed|abort|network|econnrefused|econnreset|socket|timed out/i.test(message);
}
