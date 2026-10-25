import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import type { DelegationModelChoiceRequested } from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

export const now = "2026-10-15T10:00:00.000Z";
export const childId = ThreadId.makeUnsafe("child-thread");
export const heldMessageId = MessageId.makeUnsafe("delegated-message");
export const choiceId = "model-choice:abc";
export const fallback = { provider: "codex", model: "gpt-5" } as const;
export const alternative = { provider: "claudeAgent", model: "claude-sonnet" } as const;

export function baseReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    updatedAt: now,
    threads: [
      {
        id: childId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Child",
        elevatorSummary: null,
        elevatorSummaryMessageCount: 0,
        modelSelection: fallback,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        queuedPrompts: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinnedAt: null,
        deletingAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        tasks: [],
        activities: [],
        checkpoints: [],
        session: null,
        watchingThreads: [],
      },
    ],
  };
}

export const requestedPayload: DelegationModelChoiceRequested = {
  choiceId,
  delegationId: "delegation-1",
  requested: { provider: "claudeAgent", model: "claude-opus" },
  fallback,
  reason: "provider-hidden",
  options: [
    {
      selection: fallback,
      label: "GPT-5",
      providerLabel: "Codex",
      lastUsedAt: null,
      isFallback: true,
    },
    {
      selection: alternative,
      label: "Claude Sonnet",
      providerLabel: "Claude",
      lastUsedAt: now,
      isFallback: false,
    },
  ],
  deadlineAt: "2026-10-15T10:00:10.000Z",
  heldMessageId,
};

export const holdCommand = (): OrchestrationCommand => ({
  type: "thread.delegation.model-choice.hold",
  commandId: CommandId.makeUnsafe("cmd-hold"),
  threadId: childId,
  prompt: {
    messageId: heldMessageId,
    text: "Delegated task",
    originSegments: [
      {
        kind: "initialDelegation",
        actor: "agent",
        text: "Delegated task",
        sourceThreads: [],
        verified: true,
      },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  requestedActivity: {
    id: EventId.makeUnsafe("activity-requested"),
    summary: "Choose a model",
    payload: requestedPayload,
  },
  createdAt: now,
});

export const pickCommand = (
  modelSelection: Extract<
    OrchestrationCommand,
    { type: "thread.delegation.model-choice.pick" }
  >["modelSelection"],
  id = choiceId,
): OrchestrationCommand => ({
  type: "thread.delegation.model-choice.pick",
  commandId: CommandId.makeUnsafe(`cmd-pick-${modelSelection.provider}`),
  threadId: childId,
  choiceId: id,
  modelSelection,
  createdAt: "2026-10-15T10:00:04.000Z",
});

export const expireCommand = (id = choiceId): OrchestrationCommand => ({
  type: "thread.delegation.model-choice.expire",
  commandId: CommandId.makeUnsafe(`model-choice-expire:${id}`),
  threadId: childId,
  choiceId: id,
  resolvedBy: "timeout",
  createdAt: "2026-10-15T10:00:10.000Z",
});

let sequence = 0;

export async function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  return Array.isArray(decided) ? decided : [decided];
}

export async function apply(
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  let next = readModel;
  for (const event of events) {
    sequence += 1;
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence } as OrchestrationEvent),
    );
  }
  return next;
}

export async function heldReadModel() {
  const initial = baseReadModel();
  return apply(initial, await decide(initial, holdCommand()));
}
