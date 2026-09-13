import type { IsoDateTime, ThreadId } from "@bigbud/contracts";

export function makeThreadDeletedPayload(input: {
  readonly threadId: ThreadId;
  readonly threadIds?: ReadonlyArray<ThreadId> | undefined;
  readonly origin?: "project-cascade" | undefined;
  readonly createdAt: IsoDateTime;
}) {
  return {
    threadId: input.threadId,
    ...(input.threadIds !== undefined ? { threadIds: input.threadIds } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    deletedAt: input.createdAt,
  };
}
