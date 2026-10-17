import type {
  OrchestrationMessage,
  OrchestrationReadModel,
  OrchestrationThread,
  ParentThreadReference,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";

export function verifiedOrchestraAssignmentSegments(input: {
  readonly message: {
    readonly text: string;
    readonly originSegments?: OrchestrationMessage["originSegments"];
  };
  readonly targetThread: OrchestrationThread;
  readonly readModel: OrchestrationReadModel;
}) {
  const parentId = input.targetThread.parentThread?.threadId;
  if (!parentId || input.targetThread.latestTurn !== null) return undefined;
  const parent = input.readModel.threads.find(
    (thread) =>
      thread.id === parentId &&
      thread.projectId === input.targetThread.projectId &&
      thread.deletedAt === null,
  );
  if (!parent) return undefined;
  const assignment = input.message.originSegments?.find(
    (segment) =>
      segment.kind === "orchestraAssignment" &&
      segment.actor === "userAssignment" &&
      segment.sourceThreads.length === 1 &&
      segment.sourceThreads[0]?.threadId === parent.id,
  );
  if (!assignment) return undefined;
  return [
    {
      kind: "orchestraAssignment" as const,
      actor: "userAssignment" as const,
      text: input.message.text,
      verified: true,
      sourceThreads: [{ threadId: parent.id, title: parent.title }],
    },
  ];
}

/** Seed provenance is accepted only when it matches server-known parent lineage. */
export function verifiedSeedOriginSegments(input: {
  readonly message: OrchestrationMessage;
  readonly parentThread: ParentThreadReference | undefined;
  readonly projectId: OrchestrationReadModel["threads"][number]["projectId"];
  readonly readModel: OrchestrationReadModel;
}) {
  if (!input.message.originSegments || !input.parentThread) return undefined;
  const parent = input.readModel.threads.find(
    (thread) =>
      thread.id === input.parentThread?.threadId &&
      thread.projectId === input.projectId &&
      thread.deletedAt === null,
  );
  if (!parent) return undefined;
  const verified = input.message.originSegments.filter((segment) => {
    if (segment.sourceThreads.length !== 1) return false;
    const claimedSourceId = segment.sourceThreads[0]?.threadId;
    const source = input.readModel.threads.find(
      (thread) =>
        thread.id === claimedSourceId &&
        thread.projectId === input.projectId &&
        thread.deletedAt === null,
    );
    if (!source) return false;
    if (segment.kind === "initialDelegation") return source.id === parent.id;
    return (
      segment.kind === "handoff" &&
      (source.id === parent.id || source.parentThread?.threadId === parent.id)
    );
  });
  if (verified.length === 0) return undefined;
  return verified.map((segment) => {
    const source = input.readModel.threads.find(
      (thread) => thread.id === segment.sourceThreads[0]?.threadId,
    );
    return {
      kind: segment.kind,
      actor: segment.actor,
      text: segment.text,
      verified: true,
      sourceThreads: [{ threadId: source!.id, title: source!.title }],
    };
  });
}
