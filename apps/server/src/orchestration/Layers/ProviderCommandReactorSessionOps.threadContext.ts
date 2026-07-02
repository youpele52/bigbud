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
import {
  resolveThreadWorkflowStatus,
  serializeThreadWorkflowStatusMarkdown,
} from "../ThreadWorkflowStatus.logic.ts";

export function prependThreadContextToProviderInput(input: {
  readonly providerInputText: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly computerUseEnabled?: boolean;
  readonly serverMode?: "web" | "desktop";
}): string {
  const computerUseLines =
    input.computerUseEnabled === false
      ? [
          "Desktop computer use is disabled in Bigbud settings, so native app automation (Calendar, Reminders, screen control, etc.) is unavailable.",
          'Browser automation via `computer_use` with `surface: "browser"` may still work when the browser panel is available.',
        ]
      : input.serverMode === "web"
        ? [
            'To automate native desktop apps (Calendar, Reminders, etc.), call the `computer_use` tool with `surface: "desktop"`. Desktop automation requires the Bigbud desktop app.',
            'For in-app browser automation, call `computer_use` with `surface: "browser"`.',
          ]
        : [
            'To automate native desktop apps (Calendar, Reminders, etc.), call the `computer_use` tool with `surface: "desktop"`.',
            'For in-app browser automation, call `computer_use` with `surface: "browser"`.',
            "Use `check_permissions` or `doctor` first if desktop automation fails.",
          ];

  const contextBlock = [
    "Current thread context:",
    `- Thread ID: ${input.threadId}`,
    `- Thread title: ${input.threadTitle}`,
    "",
    "To rename the current thread, call the `rename_thread` tool with the new title.",
    "To archive the current thread, call the `archive_thread` tool.",
    "To check whether another thread's agent is still active, call `get_thread_status` with that thread's ID.",
    "If your harness exposes MCP tools with provider-specific prefixes, use the available tool whose name ends with `rename_thread`, `archive_thread`, or `get_thread_status` for this current thread.",
    ...computerUseLines,
    "You must not delete threads.",
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

      const workflowStatus = resolveThreadWorkflowStatus(thread);

      return {
        threadId: thread.id,
        title: thread.title,
        markdown: [
          serializeThreadWorkflowStatusMarkdown(workflowStatus),
          serializeThreadContextMarkdown({
            id: thread.id,
            title: thread.title,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            messages: thread.messages,
          }),
        ].join("\n\n"),
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
    "Use `get_thread_status` to poll live workflow status before starting dependent work.",
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
