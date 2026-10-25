import { describe, expect, it } from "vitest";

import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { REMOTE_SERVICE_RESTARTED } from "./remoteAgentConnectionPool.errors.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import {
  REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS,
  remoteAgentReattachBackoffMs,
  type RemoteAgentReattachEnvironment,
} from "./remoteAgentProcessClient.reattach.ts";
import { describeRemoteAgentProcessReplayGap } from "./remoteAgentProcessClient.replayGap.ts";
import {
  notifyRemoteAgentReattachWake,
  waitForRemoteAgentReattachWake,
} from "./remoteAgentProcessClient.wake.ts";
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

function completedWith(exitCode: number): RemoteAgentFrame {
  return {
    type: "processCompleted",
    value: {
      requestId: "request",
      operationId: "operation",
      state: exitCode === 0 ? "completed" : "failed",
      hasExitCode: true,
      exitCode,
      outputTruncated: false,
      errorCode: exitCode === 0 ? "" : "NONZERO_EXIT",
      errorMessage: "",
    },
  };
}

function attachResponse(firstRetainedSequence: number, nextSequence: number): RemoteAgentFrame {
  return {
    type: "processAttachResponse",
    value: {
      requestId: "attach",
      operationId: "operation",
      state: "completed",
      nextSequence,
      firstRetainedSequence,
    },
  };
}

function output(sequence: number, text: string): RemoteAgentFrame {
  return {
    type: "processOutput",
    value: {
      operationId: "operation",
      sequence,
      stream: "stdout",
      bytes: new TextEncoder().encode(text),
    },
  };
}

function scripted(frames: ReadonlyArray<RemoteAgentFrame>, attaches: RemoteAgentFrame[]) {
  const queued = [...frames];
  return {
    request: async () => queued.shift()!,
    nextFrame: async () => queued.shift()!,
    send: async (frame: RemoteAgentFrame) => {
      attaches.push(frame);
    },
  } as unknown as RemoteAgentConnection;
}

/** The first connection accepts the process, then the link dies (the lid closed). */
const droppedAfterAcceptance = {
  request: async () => accepted,
  nextFrame: async () => {
    throw new RemoteAgentConnectionError("Remote agent connection is closed.");
  },
  send: async () => undefined,
} as unknown as RemoteAgentConnection;

function fakeClock(retentionMs: number) {
  let now = 0;
  const delays: number[] = [];
  const environment: RemoteAgentReattachEnvironment = {
    now: () => now,
    delay: async (ms) => {
      delays.push(ms);
      now += ms;
    },
    waitForWake: () => new Promise(() => undefined),
    random: () => 0.5,
    retentionMs,
  };
  return { environment, delays, now: () => now };
}

const run = (client: RemoteAgentProcessClient) =>
  client.run({
    workspaceHandle: "workspace",
    operationId: "operation",
    requestDigest: new Uint8Array([1]),
    command: "make",
  });

describe("remote agent process reattach across sleep", () => {
  it("keeps three immediate attempts, then waits for network-online before reattaching", async () => {
    const attaches: RemoteAgentFrame[] = [];
    let reconnects = 0;
    let networkUp = false;
    const environment: RemoteAgentReattachEnvironment = {
      now: () => 0,
      delay: () => new Promise(() => undefined),
      waitForWake: waitForRemoteAgentReattachWake,
      random: () => 0,
      retentionMs: 60_000,
    };
    const replacement = new RemoteAgentProcessClient(
      scripted([attachResponse(1, 2), output(1, "built"), completedWith(0)], attaches),
    );
    const client = new RemoteAgentProcessClient(
      droppedAfterAcceptance,
      async () => {
        reconnects += 1;
        if (!networkUp) throw new RemoteAgentConnectionError("ssh: connect to host: unreachable");
        return replacement;
      },
      { reattach: environment },
    );

    const result = run(client);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reconnects).toBe(REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS);

    networkUp = true;
    notifyRemoteAgentReattachWake();
    await expect(result).resolves.toMatchObject({ completed: { exitCode: 0 } });
    expect(reconnects).toBe(REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS + 1);
    expect(attaches.every((frame) => frame.type !== "processRequest")).toBe(true);
    expect(attaches.filter((frame) => frame.type === "processAttachRequest")).toHaveLength(1);
  });

  it("marks the outcome unknown only once the retained result would have expired", async () => {
    const retentionMs = 10 * 60_000;
    const clock = fakeClock(retentionMs);
    let reconnects = 0;
    const client = new RemoteAgentProcessClient(
      droppedAfterAcceptance,
      async () => {
        reconnects += 1;
        throw new RemoteAgentConnectionError("ssh: connect to host: unreachable");
      },
      { reattach: clock.environment },
    );

    await expect(run(client)).rejects.toMatchObject({
      code: "PROCESS_OUTCOME_UNKNOWN",
      outcome: "unknown",
    });
    expect(clock.now()).toBeGreaterThanOrEqual(retentionMs);
    expect(reconnects).toBeGreaterThan(REMOTE_AGENT_IMMEDIATE_REATTACH_ATTEMPTS);
    expect(Math.max(...clock.delays)).toBeLessThanOrEqual(30_000);
    expect(clock.delays.slice(0, -1).every((ms) => ms >= 1_000)).toBe(true);
  });

  it("does not keep retrying after the agent restarted", async () => {
    const clock = fakeClock(60_000);
    let reconnects = 0;
    const restarted = new RemoteAgentConnectionError(REMOTE_SERVICE_RESTARTED);
    const client = new RemoteAgentProcessClient(
      droppedAfterAcceptance,
      async () => {
        reconnects += 1;
        throw restarted;
      },
      { reattach: clock.environment },
    );

    await expect(run(client)).rejects.toBe(restarted);
    expect(reconnects).toBe(1);
    expect(clock.delays).toHaveLength(0);
  });

  it("gives a second drop its immediate attempts again after a successful reattach", async () => {
    const clock = fakeClock(60_000);
    const attaches: RemoteAgentFrame[] = [];
    const unreachable = () => {
      throw new RemoteAgentConnectionError("ssh: connect to host: unreachable");
    };
    let reconnects = 0;
    const reconnect = async (): Promise<RemoteAgentProcessClient> => plan[reconnects++]!();
    const options = { reattach: clock.environment };
    // Reattaches, answers the attach, then the link drops again (a second lid close).
    const attachedThenDropped = () => {
      const queued = [attachResponse(1, 1)];
      const connection = {
        nextFrame: async () => {
          const frame = queued.shift();
          if (frame) return frame;
          throw new RemoteAgentConnectionError("Remote agent connection is closed.");
        },
        send: async (frame: RemoteAgentFrame) => {
          attaches.push(frame);
        },
      } as unknown as RemoteAgentConnection;
      return new RemoteAgentProcessClient(connection, reconnect, options);
    };
    const finished = () =>
      new RemoteAgentProcessClient(
        scripted([attachResponse(1, 1), completedWith(0)], attaches),
        reconnect,
        options,
      );
    const plan: ReadonlyArray<() => RemoteAgentProcessClient> = [
      unreachable,
      unreachable,
      unreachable,
      attachedThenDropped,
      unreachable,
      unreachable,
      finished,
    ];
    const client = new RemoteAgentProcessClient(droppedAfterAcceptance, reconnect, options);

    await expect(run(client)).resolves.toMatchObject({ completed: { exitCode: 0 } });
    expect(reconnects).toBe(plan.length);
    // Only the first drop waited, once, after its three immediate attempts.
    expect(clock.delays).toHaveLength(1);
    const requestIds = attaches
      .filter((frame) => frame.type === "processAttachRequest")
      .map((frame) => (frame.value as { requestId: string }).requestId);
    expect(new Set(requestIds).size).toBe(requestIds.length);
  });

  it("surfaces an overflowed attach as finished with its exit code, output partly lost", async () => {
    const replacement = new RemoteAgentProcessClient(
      scripted(
        [attachResponse(3, 5), output(3, "tail-3"), output(4, "tail-4"), completedWith(2)],
        [],
      ),
    );
    const client = new RemoteAgentProcessClient(droppedAfterAcceptance, async () => replacement, {
      reattach: fakeClock(60_000).environment,
    });

    const result = await run(client);
    expect(result.replayGap).toBe(true);
    expect(result.completed).toMatchObject({ exitCode: 2, outputTruncated: true });
    expect(new TextDecoder().decode(result.stdout)).toBe("tail-3tail-4");
    expect(describeRemoteAgentProcessReplayGap(result.completed)).toBe(
      "finished with exit 2, output partly lost",
    );
  });
});

describe("remote agent reattach backoff", () => {
  it("stays between 1 s and 30 s with jitter", () => {
    expect(remoteAgentReattachBackoffMs(0, 0)).toBe(1_000);
    expect(remoteAgentReattachBackoffMs(0, 0.999)).toBe(1_000);
    expect(remoteAgentReattachBackoffMs(2, 0)).toBe(2_000);
    expect(remoteAgentReattachBackoffMs(2, 0.999)).toBeCloseTo(4_000, -1);
    expect(remoteAgentReattachBackoffMs(20, 0)).toBe(15_000);
    expect(remoteAgentReattachBackoffMs(20, 1)).toBe(30_000);
  });

  it("describes a lost tail without an exit code by its state", () => {
    expect(
      describeRemoteAgentProcessReplayGap({ hasExitCode: false, exitCode: 0, state: "cancelled" }),
    ).toBe("finished (cancelled), output partly lost");
  });
});
