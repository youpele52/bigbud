import { Effect } from "effect";
import type { AgentBrowserPreference } from "@bigbud/contracts/settings";
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
import { BIGBUD_PLAN_TRACKING_TOOL_INSTRUCTION } from "../../orchestration-tools/threadPlanTrackingTool.shared.ts";
import {
  resolveThreadWorkflowStatus,
  serializeThreadWorkflowStatusMarkdown,
} from "../ThreadWorkflowStatus.logic.ts";

export function prependThreadContextToProviderInput(input: {
  readonly providerInputText: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly computerUseEnabled?: boolean;
  readonly agentBrowserPreference?: AgentBrowserPreference;
  readonly serverMode?: "web" | "desktop";
}): string {
  const computerUseLines =
    input.computerUseEnabled === false
      ? [
          "Desktop computer use is disabled in Bigbud settings, so native app automation (Calendar, Reminders, screen control, etc.) is unavailable.",
          "Use the `browser` tool for bigbud's built-in visible or background browser; it does not require desktop automation.",
        ]
      : input.serverMode === "web"
        ? [
            'To automate native desktop apps (Calendar, Reminders, etc.), call the `computer_use` tool with `surface: "desktop"`. Desktop automation requires the Bigbud desktop app.',
            "Use the `browser` tool for bigbud's built-in visible or background browser.",
          ]
        : [
            'To automate native desktop apps (Calendar, Reminders, etc.), call the `computer_use` tool with `surface: "desktop"`.',
            "Use the `browser` tool for bigbud's built-in visible or background browser.",
            "Use `check_permissions` or `doctor` first if desktop automation fails.",
          ];
  const browserPreference = input.agentBrowserPreference ?? "bigbud";
  const browserPreferenceLines = [
    `The default agent browser is the ${browserPreference === "bigbud" ? "bigbud browser" : "system default browser"}. This is a preference, not a restriction; an explicit user request for the other browser always overrides it.`,
    'Use the `browser` tool for the bigbud browser. Use `computer_use` with `action: "navigate"` and `surface: "desktop"` for the system default browser.',
    "System-browser interaction requires the desktop app, full-access runtime mode, and enabled desktop computer use; surface the existing tool error when unavailable.",
    "Provider-native web search is separate and unaffected.",
  ];

  const contextBlock = [
    "Current thread context:",
    `- Thread ID: ${input.threadId}`,
    `- Thread title: ${input.threadTitle}`,
    "",
    "To rename the current thread, call the `rename_thread` tool with the new title.",
    "To archive the current thread, call the `archive_thread` tool.",
    "To create a standalone bigbud thread, call the `create_thread` tool with a title and a self-contained task that includes all necessary context.",
    "Omit `projectId` to target the current project; only provide an explicitly authorized `projectId` for another project.",
    "If a tool schema supports `workspacePath`, use it only for an authorized workspace once workspace-path policy support lands; the current implementation rejects it, so do not send it now.",
    "An accepted `create_thread` request means the request was accepted, not that the child agent has started. Use `get_thread_status` with the returned thread ID to poll startup and workflow progress.",
    "If startup is delayed, continue polling with `get_thread_status`; retry `create_thread` only when the request was rejected or no acceptance was received, and avoid duplicating an accepted child.",
    "To check whether another thread's agent is still active, call `get_thread_status` with that thread's ID.",
    "To list pinned threads globally across all projects, call the read-only `list_pinned_threads` tool.",
    "To pin a thread, call `pin_thread` with that thread's ID. Only use this when the user explicitly asks to pin a thread.",
    "To unpin a thread, call `unpin_thread` with that thread's ID. Only use this when the user explicitly asks to unpin a thread.",
    BIGBUD_PLAN_TRACKING_TOOL_INSTRUCTION,
    "If your harness exposes MCP tools with provider-specific prefixes, use the available tool whose name ends with `rename_thread`, `archive_thread`, `get_thread_status`, `list_pinned_threads`, `pin_thread`, or `unpin_thread`.",
    ...computerUseLines,
    ...browserPreferenceLines,
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
