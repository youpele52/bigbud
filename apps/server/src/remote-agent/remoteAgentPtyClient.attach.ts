import { randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import type { RemoteAgentPtyAttachResponse } from "./remoteAgentProtocol.pty";
import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types";

export async function attachRemotePty(
  connection: RemoteAgentConnection,
  ptyId: string,
  afterSequence: number,
  observed: (response: RemoteAgentPtyAttachResponse) => void,
  resumeAt: (sequence: number) => void,
  report: (error: Error) => void,
  parentSignal?: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(15_000),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  let cursor = afterSequence;
  // Bounded: output can be evicted again between a gap reply and the resumed attach.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    const requestId = randomUUID();
    const response = await connection.request(
      {
        type: "ptyAttachRequest",
        value: { requestId, ptyId, afterSequence: cursor },
      },
      (frame) => frame.type === "ptyAttachResponse" && frame.value.requestId === requestId,
      signal,
    );
    signal.throwIfAborted();
    if (response.type !== "ptyAttachResponse" || response.value.ptyId !== ptyId)
      throw new RemoteAgentPtyError(
        "PTY_ATTACH_UNKNOWN",
        "Remote attachment identity is unconfirmed.",
      );
    observed(response.value);
    if (!response.value.replayGap) return;
    report(
      new RemoteAgentPtyError(
        "PTY_REPLAY_GAP",
        `PTY output replay begins at sequence ${response.value.firstRetainedSequence}.`,
      ),
    );
    // The gap is reported explicitly; resume from the retained suffix instead of rejecting
    // every later chunk as out of order (which froze the terminal while the shell ran on).
    const resume = response.value.firstRetainedSequence - 1;
    if (!Number.isSafeInteger(resume) || resume <= cursor) return;
    resumeAt(resume);
    cursor = resume;
  }
}
