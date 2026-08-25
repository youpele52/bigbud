import { randomUUID } from "node:crypto";

import type {
  RemoteAgentWorkspaceWatchEvent,
  RemoteAgentWorkspaceWatchStartResponse,
} from "./remoteAgentProtocol.ts";
import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";

export interface RemoteAgentWorkspaceWatchSubscription {
  readonly started: RemoteAgentWorkspaceWatchStartResponse;
  readonly failed: Promise<Error>;
  readonly close: () => Promise<void>;
}

export class RemoteAgentWorkspaceWatchStartError extends RemoteAgentConnectionError {
  readonly retryable: boolean;

  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(`${errorCode || "WATCH_REJECTED"}: ${message}`);
    this.name = "RemoteAgentWorkspaceWatchStartError";
    this.retryable = errorCode === "RESOURCE_LIMIT" || errorCode === "WATCH_WORKER_STOPPED";
  }
}

export async function startRemoteAgentWorkspaceWatch(input: {
  readonly connection: RemoteAgentConnection;
  readonly subscriptionId: string;
  readonly workspaceHandle: string;
  readonly path: string;
  readonly onEvent: (event: RemoteAgentWorkspaceWatchEvent) => void;
  readonly requestId?: string;
}): Promise<RemoteAgentWorkspaceWatchSubscription> {
  const requestId = input.requestId ?? randomUUID();
  let closed = false;
  let rejectFailure: ((error: Error) => void) | undefined;
  const failed = new Promise<Error>((resolve) => {
    rejectFailure = resolve;
  });
  const removeFrameListener = input.connection.onFrame((frame) => {
    if (
      frame.type !== "workspaceWatchEvent" ||
      frame.value.subscriptionId !== input.subscriptionId
    ) {
      return false;
    }
    if (!closed) input.onEvent(frame.value);
    return true;
  });
  const removeFailureListener = input.connection.onFailure((error) => {
    if (!closed) rejectFailure?.(error);
  });

  try {
    const response = await input.connection.request(
      {
        type: "workspaceWatchStartRequest",
        value: {
          requestId,
          subscriptionId: input.subscriptionId,
          workspaceHandle: input.workspaceHandle,
          path: input.path,
        },
      },
      (frame) =>
        frame.type === "workspaceWatchStartResponse" && frame.value.requestId === requestId,
    );
    if (response.type !== "workspaceWatchStartResponse") {
      throw new RemoteAgentConnectionError("Remote workspace watch returned an invalid response.");
    }
    if (!response.value.accepted) {
      throw new RemoteAgentWorkspaceWatchStartError(
        response.value.errorCode,
        response.value.errorMessage,
      );
    }

    return {
      started: response.value,
      failed,
      close: async () => {
        if (closed) return;
        closed = true;
        const stopRequestId = randomUUID();
        try {
          await input.connection.request(
            {
              type: "workspaceWatchStopRequest",
              value: { requestId: stopRequestId, subscriptionId: input.subscriptionId },
            },
            (frame) =>
              frame.type === "workspaceWatchStopResponse" &&
              frame.value.requestId === stopRequestId,
          );
        } catch {
          // A lost connection releases all subscriptions owned by that proxy.
        } finally {
          removeFrameListener();
          removeFailureListener();
        }
      },
    };
  } catch (error) {
    closed = true;
    removeFrameListener();
    removeFailureListener();
    throw error;
  }
}
