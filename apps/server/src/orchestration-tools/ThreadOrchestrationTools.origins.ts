import { CommandId, EventId, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { createHash } from "node:crypto";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

export const stableThreadToolId = (prefix: string, value: string): string =>
  `${prefix}:${createHash("sha256").update(value).digest("hex")}`;

export const delegationError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

function delegationLinkedActivityCommand(input: {
  callerThreadId: ThreadId;
  childThreadId: ThreadId;
  childProjectId: ProjectId;
  childTitle: string;
  createdAt: string;
}) {
  return {
    type: "thread.activity.append" as const,
    commandId: CommandId.makeUnsafe(stableThreadToolId("command", `${input.childThreadId}:linked`)),
    threadId: input.callerThreadId,
    activity: {
      id: EventId.makeUnsafe(stableThreadToolId("activity", `${input.childThreadId}:linked`)),
      tone: "info" as const,
      kind: "delegation.child-linked",
      summary: `Delegated to ${input.childTitle}`,
      payload: {
        childThreadId: input.childThreadId,
        childProjectId: input.childProjectId,
        childTitle: input.childTitle,
      },
      turnId: null,
      createdAt: input.createdAt,
    },
    createdAt: input.createdAt,
  };
}

export function notifyDelegationLinked(
  input: { orchestrationEngine: OrchestrationEngineShape; callerThreadId: ThreadId },
  delegation: { childThreadId: ThreadId },
  childProjectId: ProjectId,
  childTitle: string,
  createdAt: string,
) {
  return input.orchestrationEngine.dispatch(
    delegationLinkedActivityCommand({
      callerThreadId: input.callerThreadId,
      childThreadId: delegation.childThreadId,
      childProjectId,
      childTitle,
      createdAt,
    }),
  );
}

export function buildInitialDelegationPrompt(input: {
  readonly parent: { readonly id: ThreadId; readonly title: string; readonly projectId: string };
  readonly delegationId: string;
  readonly task: string;
}) {
  return [
    "<delegated_thread_provenance>",
    `Parent thread: ${input.parent.title} (${input.parent.id})`,
    `Parent project: ${input.parent.projectId}`,
    `Delegation: ${input.delegationId}`,
    "This is a delegated standalone thread. Complete the task below and report actionable results.",
    "</delegated_thread_provenance>",
    "",
    input.task,
  ].join("\n");
}

export function initialDelegationOrigin(input: {
  readonly parent: { readonly id: ThreadId; readonly title: string };
  readonly task: string;
}) {
  return {
    kind: "initialDelegation" as const,
    actor: "agent" as const,
    text: input.task,
    sourceThreads: [{ threadId: input.parent.id, title: input.parent.title }],
    verified: true,
  };
}
