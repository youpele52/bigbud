import { randomUUID } from "node:crypto";

import { DesktopSupervisorConnection } from "./desktopSupervisorConnection.ts";
import {
  DEFAULT_DESKTOP_SUPERVISOR_LIMITS,
  DESKTOP_SUPERVISOR_PROTOCOL_MAJOR,
  DESKTOP_SUPERVISOR_PROTOCOL_MINOR,
  DesktopSupervisorProtocolError,
  type DesktopSupervisorApplicationAck,
  type DesktopSupervisorEventBatch,
  type DesktopSupervisorFrame,
  type DesktopSupervisorLimits,
} from "./desktopSupervisorProtocol.ts";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DesktopSupervisorProtocolError(`${operation} timed out`, "timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class DesktopSupervisorOwnerClient {
  private constructor(
    readonly connection: DesktopSupervisorConnection,
    readonly instanceId: string,
    readonly limits: DesktopSupervisorLimits,
  ) {}

  static async start(input: {
    readonly binaryPath: string;
    readonly clientInstanceId?: string;
    readonly limits?: DesktopSupervisorLimits;
    readonly environment?: NodeJS.ProcessEnv;
  }): Promise<DesktopSupervisorOwnerClient> {
    const limits = input.limits ?? DEFAULT_DESKTOP_SUPERVISOR_LIMITS;
    const connection = DesktopSupervisorConnection.spawn({
      binaryPath: input.binaryPath,
      maxFrameBytes: limits.maxFrameBytes,
      ...(input.environment ? { environment: input.environment } : {}),
    });
    try {
      const response = await withTimeout(
        connection.request(
          {
            type: "clientHello",
            value: {
              protocolMajor: DESKTOP_SUPERVISOR_PROTOCOL_MAJOR,
              protocolMinor: DESKTOP_SUPERVISOR_PROTOCOL_MINOR,
              clientInstanceId: input.clientInstanceId ?? randomUUID(),
              requestedLimits: limits,
            },
          },
          (frame) => frame.type === "supervisorHello",
        ),
        HANDSHAKE_TIMEOUT_MS,
        "desktop supervisor handshake",
      );
      if (response.type !== "supervisorHello") {
        throw new DesktopSupervisorProtocolError(`Expected SupervisorHello, got ${response.type}`);
      }
      if (response.value.protocolMajor !== DESKTOP_SUPERVISOR_PROTOCOL_MAJOR) {
        throw new DesktopSupervisorProtocolError(
          `Desktop supervisor protocol major ${response.value.protocolMajor} is incompatible`,
          "incompatible_protocol",
        );
      }
      if (response.value.protocolMinor < DESKTOP_SUPERVISOR_PROTOCOL_MINOR) {
        throw new DesktopSupervisorProtocolError(
          `Desktop supervisor protocol minor ${response.value.protocolMinor} lacks required application ACK confirmation`,
          "incompatible_protocol",
        );
      }
      return new DesktopSupervisorOwnerClient(
        connection,
        response.value.supervisorInstanceId,
        response.value.acceptedLimits,
      );
    } catch (cause) {
      connection.close();
      throw cause;
    }
  }

  async attach(input: {
    readonly consumerId: string;
    readonly consumerGeneration: number;
    readonly serverEpoch: string;
    readonly appliedSequence: number;
  }): Promise<number> {
    const response = await withTimeout(
      this.connection.request(
        { type: "attachConsumer", value: input },
        (frame) =>
          frame.type === "consumerAttached" &&
          frame.value.consumerId === input.consumerId &&
          frame.value.consumerGeneration === input.consumerGeneration,
      ),
      REQUEST_TIMEOUT_MS,
      "desktop supervisor attach",
    );
    if (response.type !== "consumerAttached") {
      throw new DesktopSupervisorProtocolError(`Expected ConsumerAttached, got ${response.type}`);
    }
    return response.value.acknowledgedSequence;
  }

  detach(input: {
    readonly consumerId: string;
    readonly consumerGeneration: number;
    readonly reason: string;
  }): Promise<void> {
    return withTimeout(
      this.connection.send({ type: "detachConsumer", value: input }),
      REQUEST_TIMEOUT_MS,
      "desktop supervisor detach",
    );
  }

  enqueue(batch: DesktopSupervisorEventBatch): Promise<DesktopSupervisorFrame> {
    return withTimeout(
      this.connection.request(
        { type: "eventBatch", value: batch },
        (frame) =>
          (frame.type === "eventBatch" && frame.value.batchId === batch.batchId) ||
          (frame.type === "recoveryRequired" &&
            frame.value.consumerId === batch.consumerId &&
            frame.value.consumerGeneration === batch.consumerGeneration),
      ),
      REQUEST_TIMEOUT_MS,
      "desktop supervisor delivery",
    );
  }

  async acknowledge(ack: DesktopSupervisorApplicationAck): Promise<number> {
    const response = await withTimeout(
      this.connection.request(
        { type: "applicationAck", value: ack },
        (frame) =>
          frame.type === "applicationAckAccepted" &&
          frame.value.batchId === ack.batchId &&
          frame.value.consumerId === ack.consumerId &&
          frame.value.consumerGeneration === ack.consumerGeneration,
      ),
      REQUEST_TIMEOUT_MS,
      "desktop supervisor application acknowledgement",
    );
    if (response.type !== "applicationAckAccepted") {
      throw new DesktopSupervisorProtocolError(
        `Expected ApplicationAckAccepted, got ${response.type}`,
      );
    }
    return response.value.acknowledgedSequence;
  }

  heartbeat(monotonicMillis: number): Promise<DesktopSupervisorFrame> {
    return withTimeout(
      this.connection.request(
        { type: "heartbeat", value: { monotonicMillis } },
        (frame) => frame.type === "heartbeat",
      ),
      REQUEST_TIMEOUT_MS,
      "desktop supervisor heartbeat",
    );
  }

  onFailure(listener: (error: Error) => void): () => void {
    return this.connection.onFailure(listener);
  }

  onFrame(listener: (frame: DesktopSupervisorFrame) => boolean | void): () => void {
    return this.connection.onFrame(listener);
  }

  async close(reason = "server_shutdown"): Promise<void> {
    try {
      await this.connection.send({ type: "shutdown", value: { reason } });
    } finally {
      this.connection.close();
    }
  }
}
