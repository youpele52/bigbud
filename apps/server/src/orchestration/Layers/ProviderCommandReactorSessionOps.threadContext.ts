import { Effect } from "effect";
import {
  ServerExportThreadContextError,
  type ChatAttachment,
  type OrchestrationThread,
  ThreadId,
  type ThreadId as ThreadIdType,
} from "@bigbud/contracts";
import {
  exportThreadContextFromThread,
  resolveThreadContextPath,
  serializeThreadContextMarkdown,
} from "../ThreadContextExport.ts";

export function prependThreadContextToProviderInput(input: {
  readonly providerInputText: string;
  readonly threadId: string;
  readonly threadTitle: string;
}): string {
  const contextBlock = [
    "Current thread context:",
    `- Thread ID: ${input.threadId}`,
    `- Thread title: ${input.threadTitle}`,
    "",
    "You can rename or archive the current thread if asked. You must not delete threads.",
  ].join("\n");
  if (!input.providerInputText) {
    return contextBlock;
  }
  return `${contextBlock}\n\n${input.providerInputText}`;
}

export function resolveAndExportThreadContextPath(input: {
  readonly thread: OrchestrationThread;
  readonly stateDir: string;
}): Effect.Effect<string, never> {
  const threadContextPath = resolveThreadContextPath({
    threadId: input.thread.id,
    stateDir: input.stateDir,
  });

  return Effect.tryPromise({
    try: () =>
      exportThreadContextFromThread({
        thread: {
          id: input.thread.id,
          title: input.thread.title,
          createdAt: input.thread.createdAt,
          updatedAt: input.thread.updatedAt,
          messages: input.thread.messages,
        },
        stateDir: input.stateDir,
      }),
    catch: (cause) =>
      new ServerExportThreadContextError({
        message: cause instanceof Error ? cause.message : "Failed to export current thread context",
        cause,
      }),
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.map(() => threadContextPath),
  );
}

export const appendReferencedThreadsToProviderInput = Effect.fn(
  "appendReferencedThreadsToProviderInput",
)(function* (input: {
  readonly providerInputText: string;
  readonly currentThreadId: ThreadIdType;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly resolveThread: (
    threadId: ThreadIdType,
  ) => Effect.Effect<OrchestrationThread | undefined, never>;
}) {
  const references = input.attachments.filter(
    (attachment): attachment is Extract<ChatAttachment, { type: "thread" }> =>
      attachment.type === "thread",
  );
  if (references.length === 0) {
    return input.providerInputText;
  }

  const resolvedThreads = yield* Effect.forEach(references, (reference) =>
    Effect.gen(function* () {
      if (reference.threadId === input.currentThreadId) {
        return null;
      }

      const threadId = ThreadId.makeUnsafe(reference.threadId);
      const thread = yield* input.resolveThread(threadId);
      if (!thread) {
        return {
          threadId,
          title: reference.title,
          markdown: null,
        } as const;
      }

      return {
        threadId: thread.id,
        title: thread.title,
        markdown: serializeThreadContextMarkdown({
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: thread.messages,
        }),
      } as const;
    }),
  );
  const visibleThreads = resolvedThreads.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  if (visibleThreads.length === 0) {
    return input.providerInputText;
  }

  const lines = [
    "<attached_threads>",
    "The user attached the following threads as read-only context. Do not rename, archive, or delete them unless they are the current thread and you are explicitly asked to do so.",
    "",
  ];
  for (const thread of visibleThreads) {
    lines.push(`## ${thread.title}`);
    lines.push(`- Thread ID: ${thread.threadId}`);
    lines.push("");
    lines.push(thread.markdown ?? "(thread could not be resolved)");
    lines.push("");
  }
  lines.push("</attached_threads>");

  const block = lines.join("\n");
  return input.providerInputText.length > 0 ? `${input.providerInputText}\n\n${block}` : block;
});
