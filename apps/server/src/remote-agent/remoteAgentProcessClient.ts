import { randomUUID } from "node:crypto";

import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type {
  RemoteAgentCancelResponse,
  RemoteAgentProcessCompleted,
  RemoteAgentProcessOutput,
} from "./remoteAgentProtocol.ts";

export interface RemoteAgentProcessResult {
  readonly accepted: boolean;
  readonly duplicate: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly completed: RemoteAgentProcessCompleted;
}

export interface RemoteAgentProcessRunInput {
  readonly workspaceHandle: string;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly stdin?: Uint8Array;
  readonly requestId?: string;
}

export class RemoteAgentProcessError extends Error {
  readonly _tag = "RemoteAgentProcessError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAgentProcessError";
  }
}

function append(chunks: Uint8Array[], bytes: Uint8Array): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, bytes.length);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  result.set(bytes, offset);
  return result;
}

function errorFromCompleted(completed: RemoteAgentProcessCompleted): Error | null {
  return completed.errorCode && completed.errorCode !== "NONZERO_EXIT"
    ? new RemoteAgentProcessError(completed.errorCode, completed.errorMessage)
    : null;
}

function isUnknownOperationError(cause: unknown): boolean {
  return (
    cause instanceof RemoteAgentConnectionError &&
    cause.message.includes("operation is unknown or expired")
  );
}

export class RemoteAgentProcessClient {
  private readonly activeResults = new Map<string, Promise<RemoteAgentProcessResult>>();

  constructor(
    readonly connection: RemoteAgentConnection,
    private readonly reconnect?: () => Promise<RemoteAgentProcessClient>,
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
    if (response.terminal) return response;

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

    await this.attach({ operationId: input.operationId });
    return { ...response, terminal: true, detail: "cancellation-terminal" };
  }

  async run(input: RemoteAgentProcessRunInput): Promise<RemoteAgentProcessResult> {
    return this.requestProcess(input, input.requestId ?? randomUUID(), true);
  }

  private async requestProcess(
    input: RemoteAgentProcessRunInput,
    requestId: string,
    allowResubmit: boolean,
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
      const replacement = await this.reconnect();
      try {
        return await replacement.attach({ operationId: input.operationId });
      } catch (attachCause) {
        if (!isUnknownOperationError(attachCause)) throw attachCause;
        if (!allowResubmit) {
          throw new RemoteAgentProcessError(
            "PROCESS_OUTCOME_UNKNOWN",
            `Remote process ${input.operationId} has no retained acceptance record after resubmission.`,
          );
        }
        return replacement.requestProcess(input, `${requestId}:retry`, false);
      }
    }
    if (!accepted.value.accepted) {
      throw new RemoteAgentProcessError(accepted.value.errorCode, accepted.value.errorMessage);
    }
    return this.trackResult(
      input.operationId,
      this.collectResult(accepted.value.duplicate, input.operationId, requestId, 0, 0),
    );
  }

  async attach(input: {
    readonly operationId: string;
    readonly afterSequence?: number;
    readonly requestId?: string;
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
      this.collectResult(false, input.operationId, requestId, input.afterSequence ?? 0, 0),
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
    reconnectAttempts: number,
  ): Promise<RemoteAgentProcessResult> {
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let nextSequence = afterSequence + 1;
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
          reconnectAttempts,
          stdout,
          stderr,
        });
      }
      if (frame.type === "protocolError") {
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
            reconnectAttempts,
            stdout,
            stderr,
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
        continue;
      }
      if (frame.type !== "processCompleted" || frame.value.operationId !== operationId) continue;
      const completed = frame.value as RemoteAgentProcessCompleted;
      const error = errorFromCompleted(completed);
      if (error) throw error;
      return {
        accepted: true,
        duplicate,
        stdout: append(stdout, new Uint8Array()),
        stderr: append(stderr, new Uint8Array()),
        completed,
      };
    }
  }

  private async resumeAfterTransport(input: {
    readonly cause: unknown;
    readonly duplicate: boolean;
    readonly operationId: string;
    readonly requestId: string;
    readonly afterSequence: number;
    readonly reconnectAttempts: number;
    readonly stdout: ReadonlyArray<Uint8Array>;
    readonly stderr: ReadonlyArray<Uint8Array>;
  }): Promise<RemoteAgentProcessResult> {
    if (!this.reconnect || input.reconnectAttempts >= 3) throw input.cause;
    const replacement = await this.reconnect();
    await replacement.connection.send({
      type: "processAttachRequest",
      value: {
        requestId: `${input.requestId}:attach:${input.reconnectAttempts + 1}`,
        operationId: input.operationId,
        afterSequence: input.afterSequence,
      },
    });
    const resumed = await replacement.collectResult(
      input.duplicate,
      input.operationId,
      input.requestId,
      input.afterSequence,
      input.reconnectAttempts + 1,
    );
    return {
      ...resumed,
      stdout: append([...input.stdout], resumed.stdout),
      stderr: append([...input.stderr], resumed.stderr),
    };
  }
}
