import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  TextGenerationError,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { vi } from "vitest";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";
import { maybeGenerateThreadTitleForFirstTurn } from "./ProviderCommandReactorSessionOps.title.ts";
import type { ThreadTitleGenerationInput } from "../../git/Services/TextGeneration.ts";

/** Persisted projection simulation; the production scoped rename handler is deliberately not mocked. */
export function titleFixture() {
  const now = "2026-10-17T00:00:00.000Z";
  let thread = {
    id: ThreadId.makeUnsafe(`title-stage-${crypto.randomUUID()}`),
    projectId: ProjectId.makeUnsafe("project"),
    createdAt: now,
    title: "New thread",
    modelSelection: { provider: "codex", model: "selected-unproven" },
    worktreePath: "/fixture",
    branch: null,
    workspaceExecutionTargetId: "local",
    activities: [],
    messages: [],
    archivedAt: null,
    deletingAt: null,
    deletedAt: null,
  } as unknown as OrchestrationThread;
  const generate = vi.fn(
    (_input: ThreadTitleGenerationInput) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          kind: "provider",
          detail: "Provider unavailable",
        }),
      ) as Effect.Effect<{ title: string }, TextGenerationError>,
  );
  const dispatch = vi.fn((command: OrchestrationCommand) =>
    Effect.sync(() => {
      if (command.type === "thread.activity.append")
        thread = { ...thread, activities: [...thread.activities, command.activity] };
      if (command.type === "thread.meta.update" && command.title)
        thread = { ...thread, title: command.title };
      return { sequence: 1 };
    }),
  );
  const services = {
    resolveThread: () => Effect.succeed(thread),
    orchestrationEngine: {
      dispatch,
      getReadModel: () => Effect.succeed({ threads: [thread], projects: [] }),
    },
    serverSettingsService: {
      getSettings: Effect.succeed({
        textGenerationModelSelection: { provider: "codex", model: "explicit-model" },
      }),
    },
    threadDelegationRepository: {},
    textGeneration: { generateThreadTitle: generate },
  } as unknown as SessionOpServices;
  const input = () => ({
    threadId: thread.id,
    cwd: "/fixture",
    messageText: "Investigate session reconnect",
    modelSelection: thread.modelSelection,
  });
  const addSuccess = (index: number, model = `actual-${index}`) => {
    const turnId = TurnId.makeUnsafe(`turn-${index}`),
      id = MessageId.makeUnsafe(`user-${index}`);
    thread = {
      ...thread,
      messages: [
        ...thread.messages,
        {
          id,
          role: "user",
          text: `Context from user ${index}`,
          turnId,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      activities: [
        ...thread.activities,
        {
          id: EventId.makeUnsafe(`binding-${index}`),
          kind: "text-generation.user-turn-bound",
          payload: { messageId: id },
          turnId,
          tone: "info",
          summary: "Bound user turn",
          createdAt: now,
        },
        {
          id: EventId.makeUnsafe(`success-${index}`),
          kind: "text-generation.model-succeeded",
          payload: { provider: "claudeAgent", model, subProviderID: undefined },
          turnId,
          tone: "info",
          summary: "Verified success",
          createdAt: now,
        },
      ],
    };
  };
  return {
    appendAssistant: (text: string) => {
      thread = {
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: MessageId.makeUnsafe(`assistant:${crypto.randomUUID()}`),
            role: "assistant",
            text,
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    },
    services,
    generate,
    dispatch,
    input,
    addSuccess,
    get thread() {
      return thread;
    },
    run: (retry = false) => maybeGenerateThreadTitleForFirstTurn(services)({ ...input(), retry }),
    rename: (title: string) =>
      dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("user:rename"),
        threadId: thread.id,
        title,
      }),
  };
}
