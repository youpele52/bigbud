import { afterEach, expect, it, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type {
  RemoteAgentPtyInputReconcileRequest,
  RemoteAgentPtyInputReconcileResponse,
} from "./remoteAgentProtocol.pty.ts";
import { profileOwner } from "./remoteAgentOwnedPty.profile.testUtils.ts";
import {
  parseRemoteAgentOwner,
  type RemoteAgentOwner,
  type RemoteAgentOwnerStore,
} from "./remoteAgentOwners.ts";
import { RemoteAgentOwnedInput, remoteAgentInputIdentity } from "./remoteAgentOwnedPty.input.ts";
import { RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import {
  reconcileRemotePtyInput,
  REMOTE_PTY_INPUT_RECONCILE,
} from "./remoteAgentPtyClient.reconcile.ts";

afterEach(() => vi.useRealTimers());

function owner(): RemoteAgentOwner {
  return {
    ...profileOwner(),
    nextInputSequence: 2,
    pendingInput: remoteAgentInputIdentity(1, new TextEncoder().encode("once")),
  };
}

function receipt(
  request: RemoteAgentPtyInputReconcileRequest,
  outcome = "written",
): RemoteAgentPtyInputReconcileResponse {
  const { expectedEpoch, ...identity } = request;
  return {
    ...identity,
    agentEpoch: expectedEpoch,
    outcome,
    bytesWritten: outcome === "written" ? request.byteLength : 0,
    writerUsable: true,
    accepted: true,
    errorCode: "",
  };
}

function connection(
  reply: (value: RemoteAgentPtyInputReconcileRequest) => RemoteAgentPtyInputReconcileResponse,
) {
  const request = vi.fn(async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
    if (frame.type !== "ptyInputReconcileRequest")
      throw new Error("Input bytes must never be sent");
    return { type: "ptyInputReconcileResponse", value: reply(frame.value) };
  });
  return {
    request,
    supportsCapability: (name: string) => name === REMOTE_PTY_INPUT_RECONCILE,
  } as unknown as RemoteAgentConnection & { request: typeof request };
}

it.each(["written", "failed-before-write", "not-admitted"])(
  "resolves exact %s without replaying bytes",
  async (outcome) => {
    const state = owner();
    const c = connection((request) => receipt(request, outcome));
    expect(await reconcileRemotePtyInput(c, state, new AbortController().signal)).toEqual({
      ...state.pendingInput,
      outcome,
      writerUsable: true,
    });
    expect(c.request).toHaveBeenCalledOnce();
    expect(c.request.mock.calls[0]?.[0]).not.toHaveProperty("value.bytes");
  },
);

it.each([
  { agentEpoch: "other" },
  { ptyId: "other" },
  { sequence: 2 },
  { byteLength: 3 },
  { createDigest: new Uint8Array(32) },
  { payloadDigest: new Uint8Array(32) },
  { outcome: "" },
  { outcome: "unknown" },
  { outcome: "partial-unknown", bytesWritten: 2 },
  { outcome: "written", bytesWritten: 3 },
  { outcome: "not-admitted", bytesWritten: 1 },
  { accepted: false, errorCode: "PTY_INPUT_EXPIRED" },
  { requestId: "stale" },
])("refuses mismatched/ambiguous authority %#", async (change) => {
  await expect(
    reconcileRemotePtyInput(
      connection((request) => ({ ...receipt(request), ...change })),
      owner(),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

it("observes inflight input until a full receipt without substituting retirement", async () => {
  vi.useFakeTimers();
  let count = 0;
  const c = connection((request) => receipt(request, ++count === 1 ? "writing" : "written"));
  const pending = reconcileRemotePtyInput(c, owner(), new AbortController().signal);
  await vi.advanceTimersByTimeAsync(500);
  expect((await pending).outcome).toBe("written");
  expect(c.request).toHaveBeenCalledTimes(2);
});

it("keeps writer usability separate from a full receipt", async () => {
  const value = await reconcileRemotePtyInput(
    connection((request) => ({ ...receipt(request), writerUsable: false })),
    owner(),
    new AbortController().signal,
  );
  expect(value).toMatchObject({ outcome: "written", writerUsable: false });
});

it("retries a lost retirement reply only with the same identity and no input bytes", async () => {
  const c = connection((request) => receipt(request, "not-admitted"));
  c.request.mockRejectedValueOnce(new Error("reply lost after retirement"));
  const state = owner();
  await expect(reconcileRemotePtyInput(c, state, new AbortController().signal)).rejects.toThrow(
    "reply lost",
  );
  expect((await reconcileRemotePtyInput(c, state, new AbortController().signal)).outcome).toBe(
    "not-admitted",
  );
  for (const [frame] of c.request.mock.calls) {
    expect(frame).toMatchObject({
      type: "ptyInputReconcileRequest",
      value: { sequence: 1, payloadDigest: Buffer.from(state.pendingInput!.sha256, "hex") },
    });
    expect(frame).not.toHaveProperty("value.bytes");
  }
});

it("never synthesizes identity for an old owner or sends to an unsupported agent", async () => {
  const c = connection(receipt);
  await expect(
    reconcileRemotePtyInput(c, profileOwner(), new AbortController().signal),
  ).rejects.toThrow("no compatible");
  c.supportsCapability = () => false;
  await expect(reconcileRemotePtyInput(c, owner(), new AbortController().signal)).rejects.toThrow(
    "no compatible",
  );
  expect(c.request).not.toHaveBeenCalled();
});

async function durableFixture() {
  const controller = currentRemoteAgentController();
  let state: RemoteAgentOwner = {
    ...profileOwner(),
    controllerId: controller.id,
    controllerPid: controller.pid,
    controllerStartedAt: controller.startedAt,
  };
  let loseResponse = false;
  const store = {
    get: async () => state,
    update: async (_key: string, change: (owner: RemoteAgentOwner) => RemoteAgentOwner) => {
      state = parseRemoteAgentOwner(JSON.stringify(change(state)));
      if (loseResponse) {
        loseResponse = false;
        throw new Error("durable response lost");
      }
      return state;
    },
  } as unknown as RemoteAgentOwnerStore;
  return {
    input: await RemoteAgentOwnedInput.claim(store, state),
    state: () => state,
    store,
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

it.each(["lost-written-ack", "allocated-before-crash"] as const)(
  "restores actual client writability after durable %s without replay",
  async (mode) => {
    const f = await durableFixture();
    const sent: number[] = [];
    const request = vi.fn(async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
      if (frame.type === "ptyInput") {
        sent.push(frame.value.sequence);
        if (mode === "lost-written-ack" && frame.value.sequence === 1)
          throw new Error("lost ack after write");
        return {
          type: "ptyInputResponse",
          value: {
            requestId: frame.value.requestId,
            ptyId: frame.value.ptyId,
            accepted: true,
            errorCode: "",
            errorMessage: "",
          },
        };
      }
      if (frame.type === "ptyInputReconcileRequest")
        return {
          type: "ptyInputReconcileResponse",
          value: receipt(frame.value, mode === "lost-written-ack" ? "written" : "not-admitted"),
        };
      if (frame.type === "ptyAttachRequest")
        return {
          type: "ptyAttachResponse",
          value: {
            requestId: frame.value.requestId,
            ptyId: frame.value.ptyId,
            pid: 42,
            state: "running",
            firstRetainedSequence: 1,
            nextSequence: 1,
            replayGap: false,
          },
        };
      throw new Error("Unexpected process operation");
    });
    const c = {
      request,
      supportsCapability: () => true,
      onFrame: () => () => {},
      onFailure: () => () => {},
    } as unknown as RemoteAgentConnection;
    let input = f.input;
    if (mode === "allocated-before-crash") {
      await input.allocated(1, new TextEncoder().encode("lost bytes"));
      input = await RemoteAgentOwnedInput.claim(f.store, f.state());
    }
    const process = new RemoteAgentPtyProcess(c, f.state().resourceId, async () => c, 42);
    process.restoreSequences(0, f.state().nextInputSequence, f.state().inputResolved ?? 0);
    process.setDurability({
      allocated: (sequence, bytes) => input.allocated(sequence, bytes),
      acknowledged: (sequence) => input.acknowledged(sequence),
      output: async () => {},
      reconcile: (connection, signal) => input.reconcile(connection, signal),
    });
    process.onError(() => {});
    if (mode === "lost-written-ack") process.write("once");
    else await process.attach();
    await vi.waitFor(() => expect(f.state().inputResolved).toBe(1));
    // Let the immediately resolved fixture recovery and its serialized tail drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.write("new input");
    await vi.waitFor(() => expect(f.state().inputResolved).toBe(2));
    expect(sent).toEqual(mode === "lost-written-ack" ? [1, 2] : [2]);
    expect(f.state().nextInputSequence).toBe(3);
    expect(process.pid).toBe(42);
    process.detach();
  },
);

it.each(["lost-written-ack", "lost-allocation-response"] as const)(
  "manual same-observer recovery resolves %s after transient receipt failure without replay",
  async (mode) => {
    const f = await durableFixture();
    let receiptsAvailable = false;
    let receiptRequests = 0;
    const sent: number[] = [];
    const request = vi.fn(async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
      if (frame.type === "ptyInput") {
        sent.push(frame.value.sequence);
        if (frame.value.sequence === 1) throw new Error("written ACK lost");
        return {
          type: "ptyInputResponse",
          value: {
            requestId: frame.value.requestId,
            ptyId: frame.value.ptyId,
            accepted: true,
            errorCode: "",
            errorMessage: "",
          },
        };
      }
      if (frame.type === "ptyInputReconcileRequest") {
        receiptRequests++;
        if (!receiptsAvailable) throw new Error("receipt temporarily unavailable");
        return {
          type: "ptyInputReconcileResponse",
          value: receipt(frame.value, mode === "lost-written-ack" ? "written" : "not-admitted"),
        };
      }
      if (frame.type === "ptyAttachRequest")
        return {
          type: "ptyAttachResponse",
          value: {
            requestId: frame.value.requestId,
            ptyId: frame.value.ptyId,
            pid: 42,
            state: "running",
            firstRetainedSequence: 1,
            nextSequence: 1,
            replayGap: false,
          },
        };
      throw new Error("Unexpected launch/stop operation");
    });
    const c = {
      request,
      supportsCapability: () => true,
      onFrame: () => () => {},
      onFailure: () => () => {},
    } as unknown as RemoteAgentConnection;
    const process = new RemoteAgentPtyProcess(c, f.state().resourceId, async () => c, 42);
    process.setDurability({
      allocated: (sequence, bytes) => f.input.allocated(sequence, bytes),
      acknowledged: (sequence) => f.input.acknowledged(sequence),
      output: async () => {},
      reconcile: (connection, signal) => f.input.reconcile(connection, signal),
    });
    const errors: Error[] = [];
    process.onError((error) => errors.push(error));
    if (mode === "lost-allocation-response") f.loseResponse();
    process.write("one uncertain input");
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    if (mode === "lost-written-ack") await vi.waitFor(() => expect(receiptRequests).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.state().pendingInput?.sequence).toBe(1);
    expect(f.state().inputResolved).toBe(0);
    // Explicit retry while still unavailable must refuse, not report successful recovery.
    await expect(process.retryRecovery()).rejects.toThrow("unconfirmed");
    const before = receiptRequests;
    receiptsAvailable = true;
    await Promise.all([process.retryRecovery(), process.retryRecovery()]);
    expect(receiptRequests).toBe(before + 1);
    expect(f.state().inputResolved).toBe(1);
    process.write("distinct new input");
    await vi.waitFor(() => expect(f.state().inputResolved).toBe(2));
    expect(sent).toEqual(mode === "lost-written-ack" ? [1, 2] : [2]);
    expect(process.pid).toBe(42);
    expect(f.state().nextInputSequence).toBe(3);
    process.detach();
  },
);
