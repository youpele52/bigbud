import { randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection";

/** Only idempotent controls may coalesce. Input bytes and launch operations must not use this. */
export class RemoteAgentLatestControl<T> {
  private pending: T | undefined;
  private pumping = false;
  private stopped = false;
  private readonly cancellation = new AbortController();

  constructor(
    private readonly send: (value: T, signal: AbortSignal) => Promise<void>,
    private readonly failed: (cause: unknown) => void,
  ) {}

  push(value: T): void {
    if (this.stopped) return;
    this.pending = value;
    if (!this.pumping) void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.pending = undefined;
    this.cancellation.abort();
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.pending !== undefined && !this.stopped) {
        const value = this.pending;
        this.pending = undefined;
        await this.send(
          value,
          AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(10_000)]),
        );
      }
    } catch (cause) {
      this.pending = undefined;
      if (!this.stopped) this.failed(cause);
    } finally {
      this.pumping = false;
    }
  }
}

export function createRemotePtyResizeControl(
  ptyId: string,
  connection: () => RemoteAgentConnection,
  failed: (cause: unknown) => void,
) {
  return new RemoteAgentLatestControl<{ cols: number; rows: number }>(async (size, signal) => {
    const requestId = randomUUID();
    const response = await connection().request(
      { type: "ptyResizeRequest", value: { requestId, ptyId, ...size } },
      (frame) => frame.type === "ptyResizeResponse" && frame.value.requestId === requestId,
      signal,
    );
    if (response.type !== "ptyResizeResponse" || !response.value.accepted)
      throw new Error("Remote terminal resize was rejected.");
  }, failed);
}
