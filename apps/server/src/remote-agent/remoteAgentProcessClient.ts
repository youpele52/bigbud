import { randomUUID } from "node:crypto";

import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import {
  RemoteAgentReattachRecovery,
  currentRemoteAgentReattachEnvironment,
  isDefinitiveReattachFailure,
  type RemoteAgentReattachEnvironment,
} from "./remoteAgentProcessClient.reattach.ts";
import { markRemoteAgentReplayGap } from "./remoteAgentProcessClient.replayGap.ts";
import { remoteAgentCancelEvidence } from "./remoteAgentTerminalEvidence.ts";
import type {
  RemoteAgentCancelResponse,
  RemoteAgentProcessCompleted,
  RemoteAgentProcessOutput,
} from "./remoteAgentProtocol.ts";
import {
  RemoteAgentProcessError,
  append,
  errorFromCompleted,
  isUnknownOperationError,
  outcomeUnknownAfterRetention,
  reattachCancelled,
  type RemoteAgentProcessResult,
  type RemoteAgentProcessRunInput,
} from "./remoteAgentProcessClient.types.ts";

export {
  RemoteAgentProcessError,
  type RemoteAgentProcessResult,
  type RemoteAgentProcessRunInput,
} from "./remoteAgentProcessClient.types.ts";

export interface RemoteAgentProcessClientOptions {
  /** Clock, timers and wake signal for delayed reattach; tests inject these. */
  readonly reattach?: RemoteAgentReattachEnvironment;
}

export class RemoteAgentProcessClient {
  private readonly activeResults = new Map<string, Promise<RemoteAgentProcessResult>>();

  constructor(
    readonly connection: RemoteAgentConnection,
    private readonly reconnect?: () => Promise<RemoteAgentProcessClient>,
    private readonly options: RemoteAgentProcessClientOptions = {},
  ) {}

  async cancel(input: {
    readonly operationId: string;
    readonly requestId?: string;
  }): Promise<RemoteAgentCancelResponse> {
    const requestId = input.requestId ?? randomUUID();
    const response = (await this.connection.request(
      {
        type: "cancelRequest",
        value: { requestId, operationId: input.operationId },
      },
      (frame) => frame.type === "cancelResponse" && frame.value.requestId === requestId,
    )) as { readonly type: "cancelResponse"; readonly value: RemoteAgentCancelResponse };
    return response.value;
  }

  async cancelAndWait(input: {
    readonly operationId: string;
    readonly requestId?: string;
  }): Promise<RemoteAgentCancelResponse> {
    const response = await this.cancel(input);
    const evidence = remoteAgentCancelEvidence(response);
    if (evidence === "verified-terminal") return response;
    if (evidence === "outcome-unknown" || evidence === "control-rejected") {
      throw new RemoteAgentProcessError(
        evidence === "outcome-unknown" ? "PROCESS_OUTCOME_UNKNOWN" : "PROCESS_CANCEL_REJECTED",
        "Remote cancellation did not establish a terminal operation outcome.",
      );
    }

    const active = this.activeResults.get(input.operationId);
    if (active) {
      try {
        await active;
      } catch (cause) {
        if (!(cause instanceof RemoteAgentProcessError) || cause.code !== "CANCELLED") {
          throw cause;
        }
      }
      return { ...response, terminal: true, detail: "cancellation-terminal" };
    }

    try {
      await this.attach({ operationId: input.operationId });
    } catch (cause) {
      if (!(cause instanceof RemoteAgentProcessError) || cause.outcome !== "terminal") throw cause;
    }
    return { ...response, terminal: true, detail: "cancellation-terminal" };
  }

  async run(input: RemoteAgentProcessRunInput): Promise<RemoteAgentProcessResult> {
    return this.requestProcess(input, input.requestId ?? randomUUID());
  }

  private async requestProcess(
    input: RemoteAgentProcessRunInput,
    requestId: string,
  ): Promise<RemoteAgentProcessResult> {
    let accepted: Extract<
      Awaited<ReturnType<RemoteAgentConnection["nextFrame"]>>,
      { type: "processAccepted" }
    >;
    try {
      accepted = (await this.connection.request(
        {
          type: "processRequest",
          value: {
            requestId,
            operationId: input.operationId,
            requestDigest: input.requestDigest,
            workspaceHandle: input.workspaceHandle,
            command: input.command,
            args: input.args ?? [],
            timeoutMs: input.timeoutMs ?? 30_000,
            maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024,
            ...(input.environment ? { environment: input.environment } : {}),
            ...(input.stdin ? { stdin: input.stdin } : {}),
          },
        },
        (frame) => frame.type === "processAccepted" && frame.value.requestId === requestId,
      )) as typeof accepted;
    } catch (cause) {
      if (!this.reconnect) throw cause;
      try {
        return await this.resumeAfterTransport({
          cause,
          duplicate: false,
          operationId: input.operationId,
          requestId: randomUUID(),
          afterSequence: 0,
          stdout: [],
          stderr: [],
          signal: input.signal,
        });
      } catch (attachCause) {
        if (!isUnknownOperationError(attachCause)) throw attachCause;
        throw new RemoteAgentProcessError(
          "PROCESS_OUTCOME_UNKNOWN",
          "Remote process acceptance is unknown; missing or expired history does not authorize replay.",
        );
      }
    }
    if (!accepted.value.accepted) {
      throw new RemoteAgentProcessError(
        accepted.value.errorCode,
        accepted.value.errorMessage,
        "rejected",
      );
    }
    return this.trackResult(
      input.operationId,
      this.collectResult(
        accepted.value.duplicate,
        input.operationId,
        requestId,
        0,
        undefined,
        input.signal,
      ),
    );
  }

  async attach(input: {
    readonly operationId: string;
    readonly afterSequence?: number;
    readonly requestId?: string;
    readonly signal?: AbortSignal;
  }): Promise<RemoteAgentProcessResult> {
    const requestId = input.requestId ?? randomUUID();
    await this.connection.send({
      type: "processAttachRequest",
      value: {
        requestId,
        operationId: input.operationId,
        afterSequence: input.afterSequence ?? 0,
      },
    });
    return this.trackResult(
      input.operationId,
      this.collectResult(
        false,
        input.operationId,
        requestId,
        input.afterSequence ?? 0,
        undefined,
        input.signal,
      ),
    );
  }

  private trackResult(
    operationId: string,
    result: Promise<RemoteAgentProcessResult>,
  ): Promise<RemoteAgentProcessResult> {
    this.activeResults.set(operationId, result);
    void result.then(
      () => this.clearResult(operationId, result),
      () => this.clearResult(operationId, result),
    );
    return result;
  }

  private clearResult(operationId: string, result: Promise<RemoteAgentProcessResult>): void {
    if (this.activeResults.get(operationId) === result) this.activeResults.delete(operationId);
  }

  private async collectResult(
    duplicate: boolean,
    operationId: string,
    requestId: string,
    afterSequence: number,
    recovery?: RemoteAgentReattachRecovery,
    signal?: AbortSignal,
  ): Promise<RemoteAgentProcessResult> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let nextSequence = afterSequence + 1;
    let replayGap = false;
    const seenSequences = new Set<number>();
    while (true) {
      let frame: Awaited<ReturnType<RemoteAgentConnection["nextFrame"]>>;
      try {
        frame = await this.connection.nextFrame(
          (candidate) =>
            (candidate.type === "processOutput" && candidate.value.operationId === operationId) ||
            (candidate.type === "processAckResponse" &&
              candidate.value.operationId === operationId) ||
            (candidate.type === "processAttachResponse" &&
              candidate.value.operationId === operationId) ||
            (candidate.type === "processCompleted" && candidate.value.operationId === operationId),
        );
      } catch (cause) {
        return this.resumeAfterTransport({
          cause,
          duplicate,
          operationId,
          requestId,
          afterSequence: nextSequence - 1,
          recovery,
          stdout,
          stderr,
          signal,
        });
      }
      if (frame.type === "protocolError") {
        if (
          frame.value.code === "PROCESS_REPLAY_ERROR" &&
          frame.value.message.includes("operation is unknown or expired")
        ) {
          throw new RemoteAgentProcessError(
            "PROCESS_OUTCOME_UNKNOWN",
            "Remote process history is missing or expired; the operation was not replayed.",
          );
        }
        throw new RemoteAgentConnectionError(`${frame.value.code}: ${frame.value.message}`);
      }
      if (frame.type === "processOutput") {
        if (frame.value.operationId !== operationId) continue;
        if (frame.value.sequence < nextSequence || seenSequences.has(frame.value.sequence)) {
          continue;
        }
        if (frame.value.sequence !== nextSequence) {
          throw new RemoteAgentProcessError(
            "PROCESS_OUTPUT_GAP",
            `Expected process output sequence ${nextSequence}, received ${frame.value.sequence}.`,
          );
        }
        seenSequences.add(frame.value.sequence);
        nextSequence += 1;
        const output = frame.value as RemoteAgentProcessOutput;
        (output.stream === "stdout" ? stdout : stderr).push(output.bytes);
        try {
          await this.connection.send({
            type: "processOutputAck",
            value: {
              requestId: `${requestId}:ack:${output.sequence}`,
              operationId,
              acknowledgedSequence: output.sequence,
            },
          });
        } catch (cause) {
          return this.resumeAfterTransport({
            cause,
            duplicate,
            operationId,
            requestId,
            afterSequence: nextSequence - 1,
            recovery,
            stdout,
            stderr,
            signal,
          });
        }
        continue;
      }
      if (frame.type === "processAckResponse") {
        if (frame.value.operationId === operationId && !frame.value.accepted) {
          throw new RemoteAgentProcessError(frame.value.errorCode, frame.value.errorMessage);
        }
        continue;
      }
      if (frame.type === "processAttachResponse") {
        if (frame.value.operationId !== operationId) continue;
        // Contact is back: a later drop gets its immediate attempts and full retention.
        recovery?.reset();
        if (frame.value.firstRetainedSequence > nextSequence) {
          // The agent retained only a suffix (protocol 1.3 replay gap). The
          // terminal result stays authoritative; the missing bytes are lost.
          replayGap = true;
          nextSequence = frame.value.firstRetainedSequence;
        }
        continue;
      }
      if (frame.type !== "processCompleted" || frame.value.operationId !== operationId) continue;
      const received = frame.value as RemoteAgentProcessCompleted;
      const error = errorFromCompleted(received);
      if (error) throw error;
      const completed = replayGap ? markRemoteAgentReplayGap(received) : received;
      return {
        accepted: true,
        duplicate,
        stdout: append(stdout, new Uint8Array()),
        stderr: append(stderr, new Uint8Array()),
        completed,
        ...(replayGap ? { replayGap: true } : {}),
      };
    }
  }

  /**
   * Reattaches after a transport interruption: three immediate attempts, then
   * on each network-online or sleep wake signal, or a 1-30 s jittered backoff,
   * until the agent's retained result would have expired. Only then is the
   * outcome unknown. Reattach never spawns; definitive failures, such as an
   * agent restart, are not retried. An aborted `signal` ends it as cancelled.
   */
  private async resumeAfterTransport(input: {
    readonly cause: unknown;
    readonly duplicate: boolean;
    readonly operationId: string;
    readonly requestId: string;
    readonly afterSequence: number;
    readonly recovery?: RemoteAgentReattachRecovery | undefined;
    readonly stdout: ReadonlyArray<Uint8Array>;
    readonly stderr: ReadonlyArray<Uint8Array>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<RemoteAgentProcessResult> {
    if (!this.reconnect || isDefinitiveReattachFailure(input.cause)) throw input.cause;
    const recovery =
      input.recovery ??
      new RemoteAgentReattachRecovery(
        this.options.reattach ?? currentRemoteAgentReattachEnvironment(),
      );
    let lastCause = input.cause;
    while (true) {
      const next = await recovery.beforeAttempt(input.signal);
      if (next === "cancelled") throw reattachCancelled();
      if (next === "expired") throw outcomeUnknownAfterRetention(lastCause);
      let replacement: RemoteAgentProcessClient;
      try {
        replacement = await this.reconnect();
        await replacement.connection.send({
          type: "processAttachRequest",
          value: {
            requestId: `${input.requestId}:attach:${recovery.attempts}`,
            operationId: input.operationId,
            afterSequence: input.afterSequence,
          },
        });
      } catch (cause) {
        if (isDefinitiveReattachFailure(cause)) throw cause;
        lastCause = cause;
        continue;
      }
      // Stopped while connecting: the attach request is harmless, but nothing waits for it.
      if (input.signal?.aborted) throw reattachCancelled();
      const resumed = await replacement.collectResult(
        input.duplicate,
        input.operationId,
        input.requestId,
        input.afterSequence,
        recovery,
        input.signal,
      );
      return {
        ...resumed,
        stdout: append([...input.stdout], resumed.stdout),
        stderr: append([...input.stderr], resumed.stderr),
      };
    }
  }
}
