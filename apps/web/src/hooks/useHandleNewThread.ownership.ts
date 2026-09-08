import {
  ThreadId,
  type GetThreadOwnershipResult,
  type NativeApi,
  type ProjectId,
} from "@bigbud/contracts";

import { newThreadId } from "../lib/utils";
import type { ProjectDraftThread } from "../stores/composer";

type CanonicalOwnership = Exclude<
  GetThreadOwnershipResult,
  { readonly status: "absent" | "unavailable" }
>;

export function createOwnershipReplacementThreadId(
  _ownership: CanonicalOwnership,
): Promise<ThreadId> {
  return Promise.resolve(newThreadId());
}

export type ProjectDraftOwnershipResolution =
  | { status: "reusable"; threadId: ThreadId }
  | { status: "replaced"; threadId: ThreadId }
  | { status: "unavailable"; reason: string };

export async function resolveProjectDraftOwnership(input: {
  api: Pick<NativeApi, "orchestration"> | null;
  draft: ProjectDraftThread;
  projectId: ProjectId;
  createThreadId: (ownership: CanonicalOwnership) => ThreadId | Promise<ThreadId>;
  now: () => string;
  replaceCollidingDraftThread: (replacement: {
    ownership: CanonicalOwnership;
    threadId: ThreadId;
    nextThreadId: ThreadId;
    projectId: ProjectId;
    createdAt: string;
  }) => Promise<void> | void;
}): Promise<ProjectDraftOwnershipResolution> {
  if (!input.api) {
    return { status: "unavailable", reason: "bigbud is not connected to the server." };
  }

  const ownership = await input.api.orchestration.resolveThreadOwnership({
    threadId: input.draft.threadId,
  });
  if (ownership.status === "unavailable") {
    return { status: "unavailable", reason: ownership.reason };
  }
  if (ownership.status === "absent") {
    return { status: "reusable", threadId: input.draft.threadId };
  }

  const nextThreadId = await input.createThreadId(ownership);
  await input.replaceCollidingDraftThread({
    ownership,
    threadId: input.draft.threadId,
    nextThreadId,
    projectId: input.projectId,
    createdAt: input.now(),
  });
  return { status: "replaced", threadId: nextThreadId };
}
