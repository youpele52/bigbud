import type { OrchestrationThread, ThreadId } from "@bigbud/contracts";

const LIVE_ACTIVE_SESSION_STATUSES = new Set(["connecting", "running"]);

export function threadSubtreeHasLiveActiveRuntime(input: {
  readonly threads: ReadonlyArray<Pick<OrchestrationThread, "id">>;
  readonly liveSessions: ReadonlyArray<{ readonly threadId: ThreadId; readonly status: string }>;
}): boolean {
  const liveActiveIds = new Set(
    input.liveSessions
      .filter((session) => LIVE_ACTIVE_SESSION_STATUSES.has(session.status))
      .map((session) => session.threadId),
  );
  return input.threads.some((thread) => liveActiveIds.has(thread.id));
}
