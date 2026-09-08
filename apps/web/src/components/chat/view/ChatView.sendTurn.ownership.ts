import type { NativeApi, ProjectId, ThreadId } from "@bigbud/contracts";

import { createOwnershipReplacementThreadId } from "../../../hooks/useHandleNewThread.ownership";

export function isThreadAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "thread_already_exists"
  );
}

export async function repairDuplicateCreateDraft(input: {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly error: unknown;
  readonly threadId: ThreadId;
  readonly getDraft: (threadId: ThreadId) => { readonly projectId: ProjectId } | null;
  readonly replaceCollision: (replacement: {
    threadId: ThreadId;
    nextThreadId: ThreadId;
    projectId: ProjectId;
    createdAt: string;
  }) => void;
}): Promise<ThreadId | null> {
  if (!isThreadAlreadyExistsError(input.error)) return null;
  try {
    const ownership = await input.api.orchestration.resolveThreadOwnership({
      threadId: input.threadId,
    });
    if (ownership.status === "absent" || ownership.status === "unavailable") return null;
    const draft = input.getDraft(input.threadId);
    if (!draft) return null;
    const nextThreadId = await createOwnershipReplacementThreadId(ownership);
    input.replaceCollision({
      threadId: input.threadId,
      nextThreadId,
      projectId: draft.projectId,
      createdAt: new Date().toISOString(),
    });
    return nextThreadId;
  } catch {
    return null;
  }
}
