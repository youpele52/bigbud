/** The thread's recency instant (ISO): latest user message or terminal activity, else creation. */
export function threadRecencyAt(thread: {
  readonly createdAt: string;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly latestTerminalActivityAt?: string | null | undefined;
}): string {
  const message = thread.latestUserMessageAt ?? thread.createdAt;
  const terminal = thread.latestTerminalActivityAt;
  return terminal && Date.parse(terminal) > Date.parse(message) ? terminal : message;
}
