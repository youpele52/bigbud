import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import {
  RemoteAgentPtyError,
  type RemoteAgentPtyDurability,
  type RemoteAgentPtyInputStage,
  type RemoteAgentPtyInputState,
} from "./remoteAgentPtyClient.types.ts";

const MAX_INPUT_BYTES = 64 * 1024; // Matches the native per-input admission limit.
const MAX_QUEUED_BYTES = 512 * 1024;
const MAX_QUEUED_INPUTS = 256;

interface InputOwner {
  readonly ptyId: string;
  available(): boolean;
  durability(): RemoteAgentPtyDurability | undefined;
  request(frame: RemoteAgentFrame, matches: (response: RemoteAgentFrame) => boolean): Promise<void>;
  recover(cause: Error): Promise<unknown>;
  report(error: Error): void;
  reconcile?(signal?: AbortSignal): Promise<RemoteAgentPtyInputState> | undefined;
}

/** One serialized allocator. Unsent queue entries never reserve durable identities. */
export class RemoteAgentPtyInput {
  private nextSequence = 1;
  private unknown = false;
  private tail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queuedCount = 0;
  private writerUsable = true;
  private reconciling: Promise<void> | undefined;
  private allocating: Promise<void> | undefined;

  constructor(private readonly owner: InputOwner) {}

  get pending(): boolean {
    return this.queuedCount > 0;
  }

  restore(next: number, acknowledged: number): void {
    this.nextSequence = next;
    this.unknown = next !== acknowledged + 1;
  }

  async reconcile(signal?: AbortSignal): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      // Observe allocation completion before reading its pending identity. Never restore
      // an earlier watermark while the durable allocator is still committing.
      if (this.allocating) await this.allocating.catch(() => {});
      const state = await this.owner.reconcile?.(signal);
      if (!state) return; // Legacy attach cannot resolve any uncertainty.
      if (state.nextSequence < this.nextSequence)
        throw new Error("Input reconciliation cannot rewind an allocated sequence.");
      this.restore(state.nextSequence, state.resolvedSequence);
      this.writerUsable = state.writerUsable;
      if (!state.writerUsable)
        this.owner.report(
          new RemoteAgentPtyError(
            "PTY_INPUT_UNAVAILABLE",
            "Earlier input is resolved, but the native input writer remains unavailable.",
          ),
        );
    })()
      .catch((cause) => {
        this.unknown = true;
        this.owner.report(
          new RemoteAgentPtyError(
            "PTY_INPUT_OUTCOME_UNKNOWN",
            "Remote input reconciliation is unconfirmed; input was not replayed.",
            { cause },
          ),
        );
      })
      .finally(() => {
        this.reconciling = undefined;
      });
    return this.reconciling;
  }

  async retryRecovery(): Promise<void> {
    if (!this.unknown && this.writerUsable && !this.reconciling) return;
    await this.reconcile(); // Coalesces simultaneous manual observers of the same receipt.
    this.assertUsable();
  }

  assertUsable(): void {
    if (this.unknown)
      throw new RemoteAgentPtyError(
        "PTY_INPUT_OUTCOME_UNKNOWN",
        "Remote input remains unconfirmed; it was not replayed or renumbered.",
      );
    if (!this.writerUsable)
      throw new RemoteAgentPtyError(
        "PTY_INPUT_UNAVAILABLE",
        "Remote input is resolved, but the native input writer remains unavailable.",
      );
  }

  write(data: string): void {
    if (!this.admit()) return;
    // Avoid encoding an arbitrarily large string before enforcing the byte bound.
    if (data.length > MAX_INPUT_BYTES) return this.oversized();
    const bytes = new TextEncoder().encode(data);
    if (bytes.length > MAX_INPUT_BYTES) return this.oversized();
    if (
      this.queuedBytes + bytes.length > MAX_QUEUED_BYTES ||
      this.queuedCount >= MAX_QUEUED_INPUTS
    ) {
      this.owner.report(
        new RemoteAgentPtyError(
          "PTY_INPUT_BACKPRESSURE",
          "Remote input queue is full; this input was not sent.",
        ),
      );
      return;
    }
    this.queuedBytes += bytes.length;
    this.queuedCount++;
    this.tail = this.tail
      .then(() => this.dispatch(bytes))
      .finally(() => {
        this.queuedBytes -= bytes.length;
        this.queuedCount--;
      });
  }

  private admit(): boolean {
    if (this.unknown) {
      this.owner.report(
        new RemoteAgentPtyError(
          "PTY_INPUT_OUTCOME_UNKNOWN",
          "Earlier remote input is unconfirmed. Input was not replayed or renumbered.",
        ),
      );
      return false;
    }
    if (!this.owner.available() || this.reconciling || !this.writerUsable) {
      this.owner.report(
        new RemoteAgentPtyError(
          "PTY_INPUT_NOT_SENT",
          "Remote terminal input is unavailable. This input was not sent.",
        ),
      );
      return false;
    }
    return true;
  }

  private oversized(): void {
    this.owner.report(
      new RemoteAgentPtyError(
        "PTY_INPUT_LIMIT",
        "Remote input exceeds the 64 KiB limit; this input was not sent.",
      ),
    );
  }

  private async dispatch(bytes: Uint8Array): Promise<void> {
    // Recovery/retirement may have begun while an earlier queue entry was settling.
    if (!this.admit()) return;
    const sequence = this.nextSequence++;
    const requestId = `${this.owner.ptyId}:input:${sequence}`;
    let stage: RemoteAgentPtyInputStage = "allocation";
    try {
      this.allocating = Promise.resolve().then(() =>
        this.owner.durability()?.allocated(sequence, bytes),
      );
      try {
        await this.allocating;
      } finally {
        this.allocating = undefined;
      }
      // Once allocation began, even a local cancellation must preserve uncertainty.
      stage = "request";
      await this.owner.request(
        {
          type: "ptyInput",
          value: { requestId, ptyId: this.owner.ptyId, sequence, bytes },
        },
        (frame) =>
          frame.type === "ptyInputResponse" &&
          frame.value.ptyId === this.owner.ptyId &&
          frame.value.requestId === requestId,
      );
      stage = "acknowledgement";
      await this.owner.durability()?.acknowledged(sequence);
    } catch (cause) {
      this.unknown = true;
      const error = new RemoteAgentPtyError(
        "PTY_INPUT_OUTCOME_UNKNOWN",
        `Remote input confirmation failed (${stage}). Input was not replayed or renumbered.`,
        { cause, inputStage: stage },
      );
      this.owner.report(error);
      if (stage !== "allocation") {
        try {
          await this.owner.recover(error);
          // A transport listener may have reconciled before this request's catch ran.
          // Re-read durable authority after recovery; never leave a resolved late failure sticky.
          await this.reconcile();
        } catch {
          // Recovery cannot resolve input authority. Keep the original failure/fence.
        }
      }
    }
  }
}
