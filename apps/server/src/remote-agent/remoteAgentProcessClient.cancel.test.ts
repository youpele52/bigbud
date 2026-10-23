import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentProcessClient, RemoteAgentProcessError } from "./remoteAgentProcessClient.ts";
import {
  defaultRemoteAgentReattachEnvironment,
  REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS,
  type RemoteAgentReattachEnvironment,
} from "./remoteAgentProcessClient.reattach.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

const accepted: RemoteAgentFrame = {
  type: "processAccepted",
  value: {
    requestId: "request",
    operationId: "operation",
    accepted: true,
    duplicate: false,
    errorCode: "",
    errorMessage: "",
  },
};

/** Resolves only when `signal` aborts, like a long backoff or a wake that never comes. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

const environment: RemoteAgentReattachEnvironment = {
  now: () => 0,
  delay: (_ms, signal) => untilAborted(signal),
  waitForWake: untilAborted,
  random: () => 0,
  retentionMs: 24 * 60 * 60 * 1_000,
};

/** The process was accepted, then the link died (the lid closed), and the host stays unreachable. */
function droppedLink() {
  const sent: RemoteAgentFrame[] = [];
  let reconnects = 0;
  const dropped = {
    request: async (frame: RemoteAgentFrame) => {
      sent.push(frame);
      return accepted;
    },
    nextFrame: async () => {
      throw new RemoteAgentConnectionError("Remote agent connection is closed.");
    },
    send: async (frame: RemoteAgentFrame) => {
      sent.push(frame);
    },
  } as unknown as RemoteAgentConnection;
  const client = new RemoteAgentProcessClient(
    dropped,
    async () => {
      reconnects += 1;
      throw new RemoteAgentConnectionError("ssh: connect to host: unreachable");
    },
    { reattach: environment },
  );
  return { client, sent, reconnects: () => reconnects };
}

const run = (client: RemoteAgentProcessClient, signal: AbortSignal) =>
  client.run({
    workspaceHandle: "workspace",
    operationId: "operation",
    requestDigest: new Uint8Array([1]),
    command: "make",
    signal,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cancelling a remote process reattach", () => {
  it("ends a delayed reattach as cancelled once the turn is stopped, and never respawns", async () => {
    const link = droppedLink();
    const controller = new AbortController();
    const result = run(link.client, controller.signal);
    await vi.waitFor(() =>
      expect(link.reconnects()).toBe(REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS),
    );
    // It now waits for the network or the backoff; the turn is stopped meanwhile.
    controller.abort();
    const error = await result.then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(RemoteAgentProcessError);
    expect(error).toMatchObject({ code: "PROCESS_REATTACH_CANCELLED", outcome: "cancelled" });
    expect(link.reconnects()).toBe(REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS);
    // Only the original request was ever sent: a reattach never spawns the process again.
    expect(link.sent.filter((frame) => frame.type === "processRequest")).toHaveLength(1);
  });

  it("does not reconnect at all when the turn was stopped before the link dropped", async () => {
    const link = droppedLink();
    const controller = new AbortController();
    controller.abort();
    await expect(run(link.client, controller.signal)).rejects.toMatchObject({
      code: "PROCESS_REATTACH_CANCELLED",
    });
    expect(link.reconnects()).toBe(0);
  });

  it("never keeps the server alive with its backoff timer", async () => {
    const unref = vi.fn();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
      queueMicrotask(handler);
      return { unref } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    await defaultRemoteAgentReattachEnvironment.delay(30_000, new AbortController().signal);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
