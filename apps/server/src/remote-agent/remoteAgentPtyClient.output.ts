import type { PtySequencedData } from "../terminal/Services/PTY.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import { RemoteAgentLatestControl } from "./remoteAgentPtyClient.controls";
import type { RemoteAgentPtyExited } from "./remoteAgentProtocol.pty.ts";
import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types.ts";
import { remoteAgentPtyTerminalEvidence } from "./remoteAgentTerminalEvidence.ts";

/** The exit event for a verified child exit, otherwise the error that retains ownership. */
export function remotePtyExitEvent(
  value: RemoteAgentPtyExited,
): { exitCode: number; signal: number | null } | RemoteAgentPtyError {
  if (remoteAgentPtyTerminalEvidence(value) !== "verified-terminal")
    return new RemoteAgentPtyError(
      "PTY_OUTCOME_UNKNOWN",
      "PTY control ended without a verified child exit. Recovery ownership was retained.",
    );
  return {
    exitCode: value.hasExitCode ? value.exitCode : 0,
    signal: value.hasSignal ? value.signal : null,
  };
}

/** One acknowledgement in flight and one numeric high-water mark, regardless of output rate. */
export class RemoteAgentPtyOutput {
  sequence = 0;
  readonly dataListeners = new Set<(data: string) => void>();
  readonly sequencedListeners = new Set<(event: PtySequencedData) => void>();
  private readonly decoder = new TextDecoder();
  private readonly acknowledgements: RemoteAgentLatestControl<number>;

  constructor(
    ptyId: string,
    connection: () => RemoteAgentConnection,
    persist: (sequence: number) => Promise<void> | undefined,
    failed: (cause: unknown) => void,
  ) {
    this.acknowledgements = new RemoteAgentLatestControl(async (sequence, signal) => {
      const requestId = `${ptyId}:ack:${sequence}`;
      const response = await connection().request(
        { type: "ptyOutputAck", value: { requestId, ptyId, acknowledgedSequence: sequence } },
        (frame) => frame.type === "ptyOutputAckResponse" && frame.value.requestId === requestId,
        signal,
      );
      if (response.type !== "ptyOutputAckResponse" || !response.value.accepted)
        throw new Error("Remote terminal output acknowledgement was rejected.");
      if (!signal.aborted) await persist(sequence);
    }, failed);
  }

  /** Applies the next ordered chunk; duplicates are dropped and a gap is returned, not applied. */
  apply(sequence: number, bytes: Uint8Array): RemoteAgentPtyError | undefined {
    if (sequence <= this.sequence) return undefined;
    if (sequence !== this.sequence + 1)
      return new RemoteAgentPtyError(
        "PTY_OUTPUT_GAP",
        `Expected PTY output sequence ${this.sequence + 1}, received ${sequence}.`,
      );
    this.sequence = sequence;
    this.emit(this.decoder.decode(bytes, { stream: true }));
    this.acknowledge(sequence);
    return undefined;
  }

  /** Flushes a trailing partial character, attributed to the last applied sequence. */
  finish(): void {
    this.stop();
    const remainder = this.decoder.decode();
    if (remainder.length > 0) this.emit(remainder);
  }

  private emit(text: string): void {
    if (text.length > 0) for (const listener of this.dataListeners) listener(text);
    const event = { sequence: this.sequence, data: text };
    for (const listener of this.sequencedListeners) listener(event);
  }

  stop(): void {
    this.acknowledgements.stop();
  }

  acknowledge(sequence: number): void {
    this.acknowledgements.push(sequence);
  }
}
