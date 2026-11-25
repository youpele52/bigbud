import { PassThrough } from "node:stream";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PI_OWNER_CANCEL_TIMEOUT_MS,
  PI_OWNER_START_TIMEOUT_MS,
  startOwnedPiRpcProcess,
  type OwnedPiRpcInput,
  type PiOwnerExit,
  type PiOwnerSession,
  type PiRpcOwner,
} from "./RpcProcess.owner.ts";
import { PI_VERSION_PROBE_TIMEOUT_MS } from "./RpcProcess.version.ts";

const input = {
  threadId: ThreadId.makeUnsafe("thread-pi"),
  sessionEpoch: 2,
  providerRuntimeTarget: { location: "remote", executionTargetId: "ssh:pi-host" },
  workspaceTarget: { location: "remote", executionTargetId: "ssh:pi-host", cwd: "/work/p i" },
  binaryPath: "/opt/pi tools/pi",
  sessionFile: "/sessions/prior session.jsonl",
} satisfies Omit<OwnedPiRpcInput, "owner">;

function fixture() {
  const exit = Promise.withResolvers<PiOwnerExit>();
  const pipes = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
  const session = { ...pipes, exit: exit.promise } satisfies PiOwnerSession;
  const ready = Promise.withResolvers<PiOwnerSession>();
  const cancel = vi.fn(async () => {});
  const owner = {
    probeProvider: vi.fn<PiRpcOwner["probeProvider"]>().mockResolvedValue("pi v0.99.0\n"),
    startProvider: vi.fn<PiRpcOwner["startProvider"]>(() => ({ ready: ready.promise, cancel })),
  };
  return { owner, session, ready, exit, cancel };
}

function nextStart(owner: ReturnType<typeof fixture>["owner"]) {
  const started = Promise.withResolvers<void>();
  const start = owner.startProvider.getMockImplementation()!;
  owner.startProvider.mockImplementationOnce((request) => {
    const handle = start(request);
    started.resolve();
    return handle;
  });
  return started.promise;
}

afterEach(() => vi.useRealTimers());

describe("Pi SSH owner launch seam", () => {
  it("probes and starts the same authorized runtime, with only typed Pi operands and separate pipes", async () => {
    const { owner, session, ready, exit } = fixture();
    ready.resolve(session);
    const lease = await startOwnedPiRpcProcess({ ...input, owner });
    const runtime = {
      provider: "pi",
      threadId: input.threadId,
      sessionEpoch: 2,
      executionTargetId: "ssh:pi-host",
      binaryPath: "/opt/pi tools/pi",
      cwd: "/work/p i",
    };
    expect(owner.probeProvider).toHaveBeenCalledExactlyOnceWith(runtime, expect.any(AbortSignal));
    expect(owner.startProvider).toHaveBeenCalledExactlyOnceWith({
      ...runtime,
      sessionFile: input.sessionFile,
    });
    expect(lease).toMatchObject({ supportsAgentSettled: true, supportsPromptDisposition: true });
    expect(lease.stdin).toBe(session.stdin);
    expect(lease.stdout).toBe(session.stdout);
    expect(lease.stderr).toBe(session.stderr);
    exit.resolve({ kind: "signaled", signal: "SIGTERM" });
    await expect(lease.exit).resolves.toEqual({ kind: "signaled", signal: "SIGTERM" });
  });

  it.each([
    { providerRuntimeTarget: { location: "local", executionTargetId: "local" } },
    { workspaceTarget: { ...input.workspaceTarget, executionTargetId: "ssh:another-host" } },
    ...["ssh:host=pi-host&transport=agent", "not-ssh"].map((executionTargetId) => ({
      providerRuntimeTarget: { ...input.providerRuntimeTarget, executionTargetId },
      workspaceTarget: { ...input.workspaceTarget, executionTargetId },
    })),
    { workspaceTarget: { ...input.workspaceTarget, cwd: "relative" } },
    { binaryPath: "--help" },
    { sessionFile: "/sessions/bad\0file" },
    { sessionFile: "é".repeat(2_049) },
    { sessionEpoch: Number.NaN },
  ] satisfies Partial<OwnedPiRpcInput>[])(
    "rejects ineligible targets and operands before dispatch (%#)",
    async (overrides) => {
      const { owner } = fixture();
      await expect(startOwnedPiRpcProcess({ ...input, ...overrides, owner })).rejects.toThrow();
      expect(owner.probeProvider).not.toHaveBeenCalled();
      expect(owner.startProvider).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["not a version", "supported semantic version"],
    ["é".repeat(2_049), "exceeded its output limit"],
  ])("never starts after an invalid or oversized probe (%#)", async (version, detail) => {
    const { owner } = fixture();
    owner.probeProvider.mockResolvedValueOnce(version);
    await expect(startOwnedPiRpcProcess({ ...input, owner })).rejects.toThrow(detail);
    expect(owner.startProvider).not.toHaveBeenCalled();
  });

  it("preserves owner failure instead of retrying with another launcher", async () => {
    const { owner } = fixture();
    const denied = new Error("fixture grant denied");
    owner.probeProvider.mockRejectedValueOnce(denied);
    await expect(startOwnedPiRpcProcess({ ...input, owner })).rejects.toBe(denied);
    expect(owner.probeProvider).toHaveBeenCalledTimes(1);
    expect(owner.startProvider).not.toHaveBeenCalled();
    owner.startProvider.mockImplementationOnce(() => {
      throw denied;
    });
    await expect(startOwnedPiRpcProcess({ ...input, owner })).rejects.toBe(denied);
    expect(owner.startProvider).toHaveBeenCalledTimes(1);
  });

  it("does not probe when cancelled before dispatch", async () => {
    const { owner } = fixture();
    const reason = new Error("already cancelled");
    await expect(
      startOwnedPiRpcProcess({ ...input, owner, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(owner.probeProvider).not.toHaveBeenCalled();
    expect(owner.startProvider).not.toHaveBeenCalled();
  });

  it("bounds a stalled probe and aborts its owner operation", async () => {
    vi.useFakeTimers();
    const { owner } = fixture();
    owner.probeProvider.mockReturnValueOnce(new Promise(() => {}));
    const result = expect(startOwnedPiRpcProcess({ ...input, owner })).rejects.toThrow(
      "version probe timed out",
    );
    await vi.advanceTimersByTimeAsync(PI_VERSION_PROBE_TIMEOUT_MS);
    await result;
    expect(owner.probeProvider.mock.calls[0]?.[1].aborted).toBe(true);
    expect(owner.startProvider).not.toHaveBeenCalled();
  });

  it("does not start if cancelled during the probe, even when the result eventually arrives", async () => {
    const { owner } = fixture();
    const controller = new AbortController();
    const probe = Promise.withResolvers<string>();
    const probing = Promise.withResolvers<AbortSignal>();
    owner.probeProvider.mockImplementationOnce((_request, signal) => {
      probing.resolve(signal);
      return probe.promise;
    });
    const acquisition = startOwnedPiRpcProcess({ ...input, owner, signal: controller.signal });
    const signal = await probing.promise;
    const reason = new Error("cancel probe");
    controller.abort(reason);
    await expect(acquisition).rejects.toBe(reason);
    expect(signal.reason).toBe(reason);
    probe.resolve("1.0.0");
    await Promise.resolve();
    expect(owner.startProvider).not.toHaveBeenCalled();
  });

  it("cleans up a failed start before surfacing the owner error", async () => {
    const { owner, ready, cancel } = fixture();
    const started = nextStart(owner);
    const failure = new Error("fixture pipe acquisition failed");
    const result = expect(startOwnedPiRpcProcess({ ...input, owner })).rejects.toBe(failure);
    await started;
    ready.reject(failure);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the exact pending reservation and waits for close when ready races cancellation", async () => {
    const { owner, ready, session, cancel } = fixture();
    const started = nextStart(owner);
    const controller = new AbortController();
    const confirmation = Promise.withResolvers<void>();
    const cancelling = Promise.withResolvers<void>();
    cancel.mockImplementationOnce(() => {
      cancelling.resolve();
      return confirmation.promise;
    });
    const acquisition = startOwnedPiRpcProcess({ ...input, owner, signal: controller.signal });
    const reason = new Error("cancel start");
    const result = expect(acquisition).rejects.toBe(reason);
    const settled = vi.fn();
    void acquisition.then(settled, settled);
    await started;
    controller.abort(reason);
    await cancelling.promise;
    ready.resolve(session);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    confirmation.resolve();
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds both startup and cleanup, reporting unconfirmed teardown separately from the start timeout", async () => {
    vi.useFakeTimers();
    const { owner, cancel } = fixture();
    cancel.mockReturnValueOnce(new Promise(() => {}));
    const acquisition = startOwnedPiRpcProcess({ ...input, owner });
    const result = expect(acquisition).rejects.toMatchObject({
      message: "Pi SSH owner RPC start cleanup failed.",
      errors: [
        expect.objectContaining({ message: expect.stringContaining("start timed out") }),
        expect.objectContaining({
          message: expect.stringContaining("confirm RPC transport teardown"),
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(PI_OWNER_START_TIMEOUT_MS);
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PI_OWNER_CANCEL_TIMEOUT_MS);
    await result;
  });

  it("hands off cancellation to the particular session and retains transport loss as an unknown exit", async () => {
    const first = fixture();
    const other = fixture();
    first.ready.resolve(first.session);
    other.ready.resolve(other.session);
    const controller = new AbortController();
    const [lease, sibling] = await Promise.all([
      startOwnedPiRpcProcess({ ...input, owner: first.owner, signal: controller.signal }),
      startOwnedPiRpcProcess({
        ...input,
        sessionEpoch: input.sessionEpoch + 1,
        owner: other.owner,
      }),
    ]);
    controller.abort();
    expect(first.cancel).not.toHaveBeenCalled();
    await Promise.all([lease.cancel(), lease.cancel()]);
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(other.cancel).not.toHaveBeenCalled();
    const lost = new Error("fixture owner disconnected");
    other.exit.reject(lost);
    await expect(sibling.exit).rejects.toBe(lost);
  });
});
