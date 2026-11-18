import type { RemoteAgentConnection } from "./remoteAgentConnection";
import { RemoteAgentLatestControl } from "./remoteAgentPtyClient.controls";

/** One acknowledgement in flight and one numeric high-water mark, regardless of output rate. */
export class RemoteAgentPtyOutput {
  sequence = 0;
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

  decode(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  finish(): string {
    this.stop();
    return this.decoder.decode();
  }

  stop(): void {
    this.acknowledgements.stop();
  }

  acknowledge(sequence: number): void {
    this.acknowledgements.push(sequence);
  }
}
