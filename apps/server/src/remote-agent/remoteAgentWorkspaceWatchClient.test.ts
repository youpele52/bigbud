import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  RemoteAgentWorkspaceWatchStartError,
  startRemoteAgentWorkspaceWatch,
} from "./remoteAgentWorkspaceWatchClient.ts";

describe("remote agent workspace watch client", () => {
  it("consumes matching events and stops the remote subscription", async () => {
    let frameListener: ((frame: RemoteAgentFrame) => boolean) | undefined;
    const received = vi.fn();
    const request = vi.fn(async (frame: RemoteAgentFrame) => {
      if (frame.type === "workspaceWatchStartRequest") {
        return {
          type: "workspaceWatchStartResponse",
          value: {
            requestId: frame.value.requestId,
            subscriptionId: frame.value.subscriptionId,
            accepted: true,
            generation: 2,
            backend: "native",
            errorCode: "",
            errorMessage: "",
          },
        } satisfies RemoteAgentFrame;
      }
      if (frame.type !== "workspaceWatchStopRequest") throw new Error("unexpected request");
      return {
        type: "workspaceWatchStopResponse",
        value: {
          requestId: frame.value.requestId,
          subscriptionId: frame.value.subscriptionId,
          stopped: true,
        },
      } satisfies RemoteAgentFrame;
    });
    const connection = {
      request,
      onFrame: (listener: (frame: RemoteAgentFrame) => boolean) => {
        frameListener = listener;
        return () => {
          frameListener = undefined;
        };
      },
      onFailure: () => () => {},
    } as unknown as RemoteAgentConnection;

    const subscription = await startRemoteAgentWorkspaceWatch({
      connection,
      subscriptionId: "watch-1",
      workspaceHandle: "workspace-1",
      path: "docs",
      onEvent: received,
      requestId: "start-1",
    });
    expect(subscription.started.backend).toBe("native");
    expect(
      frameListener?.({
        type: "workspaceWatchEvent",
        value: {
          subscriptionId: "watch-1",
          generation: 2,
          sequence: 1,
          changes: [{ path: "docs/README.md", kind: "modify" }],
          rescanRequired: false,
          rescanReason: "",
          backend: "native",
        },
      }),
    ).toBe(true);
    expect(received).toHaveBeenCalledOnce();

    await subscription.close();
    expect(frameListener).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves retryability for typed start rejections", async () => {
    const connection = {
      request: async (frame: RemoteAgentFrame) => {
        if (frame.type !== "workspaceWatchStartRequest") throw new Error("unexpected request");
        return {
          type: "workspaceWatchStartResponse",
          value: {
            requestId: frame.value.requestId,
            subscriptionId: frame.value.subscriptionId,
            accepted: false,
            generation: 0,
            backend: "",
            errorCode: "RESOURCE_LIMIT",
            errorMessage: "limit reached",
          },
        } satisfies RemoteAgentFrame;
      },
      onFrame: () => () => {},
      onFailure: () => () => {},
    } as unknown as RemoteAgentConnection;

    const result = startRemoteAgentWorkspaceWatch({
      connection,
      subscriptionId: "watch-1",
      workspaceHandle: "workspace-1",
      path: ".",
      onEvent: () => {},
    });
    await expect(result).rejects.toMatchObject({
      name: "RemoteAgentWorkspaceWatchStartError",
      errorCode: "RESOURCE_LIMIT",
      retryable: true,
    } satisfies Partial<RemoteAgentWorkspaceWatchStartError>);
  });
});
