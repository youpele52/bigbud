/**
 * Provider sessions the server starts on its own (learning reviews, durable V2 learning) run
 * under synthetic thread ids with this prefix. They are not user-driven threads: no user sees or
 * steers them, so tools with side effects beyond the session (peer delegation) are not offered.
 *
 * @module backgroundSessionThreads
 */
export const BACKGROUND_SESSION_THREAD_PREFIX = "learning-";

export function isBackgroundSessionThreadId(threadId: string): boolean {
  return threadId.startsWith(BACKGROUND_SESSION_THREAD_PREFIX);
}
