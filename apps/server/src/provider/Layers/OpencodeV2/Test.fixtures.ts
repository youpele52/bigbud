import type { OpenCodeEvent } from "@opencode/client";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Synthetic live-only source, with no provider credentials or native profile access. */
export class FixtureEvents {
  private readonly queue: OpenCodeEvent[] = [];
  private wake = deferred<void>();
  subscriptions = 0;

  push(event: OpenCodeEvent): void {
    this.queue.push(event);
    this.wake.resolve();
  }

  async *subscribe(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    this.subscriptions++;
    const abort = () => this.wake.resolve();
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (!signal.aborted) {
        const event = this.queue.shift();
        if (event) yield event;
        else {
          await this.wake.promise;
          this.wake = deferred<void>();
        }
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

export const fixtureEvent = (
  sessionID = "ses_one",
  directory = "/one",
  delta = "text",
): OpenCodeEvent => ({
  id: `event-${sessionID}-${delta}`,
  type: "session.text.delta",
  created: 1,
  location: { directory },
  data: { sessionID, assistantMessageID: "msg_assistant", ordinal: 0, delta },
});

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
