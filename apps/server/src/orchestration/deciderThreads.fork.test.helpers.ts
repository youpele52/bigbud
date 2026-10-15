import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

export const NOW = "2026-10-15T10:00:00.000Z";
export const SOURCE = ThreadId.makeUnsafe("source-thread");
export const PROJECT = ProjectId.makeUnsafe("fork-project");
export const IMAGE = {
  type: "image" as const,
  id: "thread-attachment-00000000-0000-4000-8000-000000000077",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 4,
};

const at = (index: number) => new Date(Date.parse(NOW) - 1_000_000 + index * 1_000).toISOString();

export function message(
  id: string,
  role: "user" | "assistant",
  index: number,
  extra: Partial<OrchestrationMessage> = {},
): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text: `${role} ${id}`,
    turnId: null,
    streaming: false,
    createdAt: at(index),
    updatedAt: at(index),
    ...extra,
  } as OrchestrationMessage;
}

export function activity(id: string, kind: string, index: number, payload: unknown = {}) {
  return {
    id: EventId.makeUnsafe(id),
    tone: kind === "provider.turn.start.failed" ? "error" : "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: at(index),
  } as OrchestrationThreadActivity;
}

/** Completed history (`pairs` user/assistant pairs), plus optional extras. */
export function sourceThread(input: {
  readonly pairs: number;
  readonly provider?: "codex" | "opencodeV2";
  readonly extraMessages?: ReadonlyArray<OrchestrationMessage>;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn?: OrchestrationThread["latestTurn"];
  readonly plans?: number;
  readonly tasks?: number;
}): OrchestrationThread {
  const messages: OrchestrationMessage[] = [];
  for (let index = 0; index < input.pairs; index++) {
    messages.push(message(`user-${index}`, "user", index * 2));
    messages.push(
      message(`assistant-${index}`, "assistant", index * 2 + 1, {
        turnId: TurnId.makeUnsafe(`turn-${index}`),
      }),
    );
  }
  return {
    id: SOURCE,
    projectId: PROJECT,
    title: "Long running work",
    elevatorSummary: null,
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: input.provider ?? "codex", model: "model-a" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "feature/x",
    worktreePath: "/tmp/worktree-x",
    latestTurn: input.latestTurn ?? null,
    queuedPrompts: [],
    createdAt: at(0),
    updatedAt: NOW,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [...messages, ...(input.extraMessages ?? [])],
    proposedPlans: Array.from({ length: input.plans ?? 0 }, (_, index) => ({
      id: `plan-${index}`,
      turnId: null,
      planMarkdown: `# Plan ${index}`,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: at(index),
      updatedAt: at(index),
    })),
    tasks: Array.from({ length: input.tasks ?? 0 }, (_, index) => ({
      id: `task-${index}`,
      status: "completed",
      subject: `Task ${index}`,
      source: "lifecycle",
      createdAt: at(index),
      updatedAt: at(index),
      ...(index > 0 ? { parentTaskId: `task-${index - 1}` } : {}),
    })) as never,
    activities: [...(input.activities ?? [])],
    checkpoints: [],
    session: null,
    watchingThreads: [],
  } as OrchestrationThread;
}

export function readModel(...threads: OrchestrationThread[]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: NOW,
    projects: [
      {
        id: PROJECT,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ] as never,
    threads,
  };
}

export function forkCommand(input: {
  readonly threadId?: string;
  readonly commandId?: string;
  readonly reason?: "manual" | "recovery-failed";
  readonly failureEventId?: string;
  readonly pendingMessageId?: string;
  readonly modelSelection?: { provider: "codex" | "claudeAgent"; model: string };
}) {
  return {
    type: "thread.fork" as const,
    commandId: CommandId.makeUnsafe(input.commandId ?? "cmd-fork"),
    sourceThreadId: SOURCE,
    threadId: ThreadId.makeUnsafe(input.threadId ?? "fork-thread"),
    reason: input.reason ?? "manual",
    ...(input.failureEventId ? { failureEventId: EventId.makeUnsafe(input.failureEventId) } : {}),
    ...(input.pendingMessageId
      ? { pendingMessageId: MessageId.makeUnsafe(input.pendingMessageId) }
      : {}),
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    createdAt: NOW,
  };
}

export const decide = (model: OrchestrationReadModel, command: ReturnType<typeof forkCommand>) =>
  Effect.runPromise(
    decideOrchestrationCommand({ command: command as never, readModel: model }).pipe(
      Effect.map((events) => (Array.isArray(events) ? events : [events])),
    ),
  ) as Promise<ReadonlyArray<Omit<OrchestrationEvent, "sequence">>>;

/** Applies decided events to the read model like the engine does. */
export async function apply(
  model: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): Promise<OrchestrationReadModel> {
  let next = model;
  for (const [index, event] of events.entries()) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: index + 1 } as OrchestrationEvent),
    );
  }
  return next;
}
