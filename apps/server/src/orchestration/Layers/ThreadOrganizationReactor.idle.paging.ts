import type {
  IdleThreadCandidate,
  IdleThreadCursor,
} from "../../persistence/Services/ProjectionThreads.ts";

/** One bounded keyset page per rule/tick; retries cannot pin the scan to its oldest rows. */
export function makeIdleSweepPaging() {
  const cursors = new Map<"idle" | "older", IdleThreadCursor>();
  return {
    after: (rule: "idle" | "older") => cursors.get(rule),
    advance: (rule: "idle" | "older", page: ReadonlyArray<IdleThreadCandidate>, limit: number) => {
      const last = page.at(-1);
      if (page.length < limit || !last) cursors.delete(rule);
      else cursors.set(rule, { activityAt: last.activityAt, threadId: last.threadId });
    },
    reset: (rule: "idle" | "older") => {
      cursors.delete(rule);
    },
  };
}
