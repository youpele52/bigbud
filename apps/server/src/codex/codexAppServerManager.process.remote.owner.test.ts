import { PassThrough } from "node:stream";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_OWNER_CANCEL_TIMEOUT_MS,
  CODEX_OWNER_START_TIMEOUT_MS,
  REMOTE_CODEX_ASYNC_PROBE_TIMEOUT_MS,
  REMOTE_CODEX_PROBE_MAX_BYTES,
  type CodexOwnerSession,
  type CodexSshOwner,
} from "./codexAppServerManager.process.remote.owner.ts";
import {
  assertSupportedRemoteCodexCliVersionAsync,
  startRemoteCodexAppServerProcess,
  startRemoteCodexAppServerProcessAsync,
} from "./codexAppServerManager.process.remote.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";

const target = "ssh:host=codex.invalid&user=dev&transport=direct-ssh";
const input = {
  threadId: ThreadId.makeUnsafe("thread-codex"),
  sessionEpoch: 7,
  provider: "codex",
  providerRuntimeExecutionTargetId: target,
  workspaceExecutionTargetId: target,
  executionTargetId: "local", // The explicit split targets take precedence.
  cwd: " /srv/project ",
  binaryPath: "/opt/bin/codex",
  homePath: "/srv/codex-home",
  runtimeMode: "full-access",
} satisfies CodexAppServerStartSessionInput;
const versionOutput = { status: 0, stdout: "codex-cli 0.167.0\n", stderr: "" };

function fixture() {
  const ready = Promise.withResolvers<CodexOwnerSession>();
  const exit = Promise.withResolvers<Awaited<CodexOwnerSession["exit"]>>();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const cancelled = vi.fn(async () => {});
  const dispatched = Promise.withResolvers<void>();
  const owner = {
    probeProvider: vi.fn<CodexSshOwner["probeProvider"]>(async () => versionOutput),
    startProvider: vi.fn<CodexSshOwner["startProvider"]>(() => {
      dispatched.resolve();
      return { ready: ready.promise, cancel: cancelled };
    }),
  } satisfies CodexSshOwner;
  return {
    owner,
    ready,
    exit,
    stdin,
    stdout,
    stderr,
    cancelled,
    dispatched,
    pipes: { stdin, stdout, stderr, exit: exit.promise },
  };
}

function watchLegacyReadiness() {
  // SSH readiness is the owner's; there is no TypeScript readiness probe to watch.
  return () => undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("selected Codex SSH owner at the remote process boundary", () => {
  it("passes only the scoped recipe operands, and hands off separate pipes and verified exit", async () => {
    const noLegacy = watchLegacyReadiness();
    const { owner, ready, pipes, exit, cancelled } = fixture();
    const controller = new AbortController();
    ready.resolve(pipes);
    const scopedInput = {
      ...input,
      command: "must not forward",
      env: { TEST: "secret" },
      args: ["bad"],
    };
    const process = await startRemoteCodexAppServerProcessAsync(scopedInput, controller.signal, {
      owner,
    });
    const expected = {
      provider: "codex",
      threadId: input.threadId,
      sessionEpoch: 7,
      executionTargetId: target,
      cwd: "/srv/project",
      binaryPath: input.binaryPath,
      homePath: input.homePath,
    };
    expect(owner.probeProvider).toHaveBeenCalledExactlyOnceWith(expected, expect.any(AbortSignal));
    expect(owner.startProvider).toHaveBeenCalledExactlyOnceWith({
      ...expected,
      enableDefaultModeUserInput: true,
    });
    expect(process.version).toBe("0.167.0");
    expect(process.stdin).toBe(pipes.stdin);
    expect(process.stdout).toBe(pipes.stdout);
    expect(process.stderr).toBe(pipes.stderr);
    expect(process).not.toHaveProperty("pid");
    controller.abort(); // Acquisition no longer owns the returned lease.
    exit.resolve({ kind: "signaled", signal: "SIGTERM" });
    await expect(process.exit).resolves.toEqual({ kind: "signaled", signal: "SIGTERM" });
    expect(cancelled).not.toHaveBeenCalled();
    noLegacy();
  });

  it("uses the same frozen scope for both operations", async () => {
    const { owner, ready, pipes } = fixture();
    const mutableInput = { ...input };
    ready.resolve(pipes);
    owner.probeProvider.mockImplementation(async (scope) => {
      expect(Object.isFrozen(scope)).toBe(true);
      mutableInput.cwd = "/srv/other";
      mutableInput.sessionEpoch = 8;
      return versionOutput;
    });
    await startRemoteCodexAppServerProcessAsync(mutableInput, undefined, { owner });
    const request = owner.startProvider.mock.calls[0]?.[0];
    expect(Object.isFrozen(request)).toBe(true);
    expect(request).toMatchObject({ cwd: "/srv/project", sessionEpoch: 7 });
  });

  it.each(["codex-cli 0.166.0", "unrecognized version output"])(
    "omits the new question feature for %s",
    async (stdout) => {
      const { owner, ready, pipes } = fixture();
      ready.resolve(pipes);
      owner.probeProvider.mockResolvedValue({ ...versionOutput, stdout });
      await startRemoteCodexAppServerProcessAsync(input, undefined, { owner });
      expect(owner.startProvider).toHaveBeenCalledWith(
        expect.objectContaining({ enableDefaultModeUserInput: false }),
      );
    },
  );

  it.each([
    { patch: { providerRuntimeExecutionTargetId: "local" }, detail: "direct SSH runtime" },
    { patch: { workspaceExecutionTargetId: "ssh:another.invalid" }, detail: "same target" },
    {
      patch: {
        executionTargetId: "local",
        providerRuntimeExecutionTargetId: "ssh:host=codex.invalid&transport=agent",
        workspaceExecutionTargetId: "ssh:host=codex.invalid&transport=agent",
      },
      detail: "direct SSH runtime",
    },
    { patch: { cwd: "../other" }, detail: "Invalid Codex SSH owner operand" },
    { patch: { binaryPath: " -x" }, detail: "Invalid Codex SSH owner operand" },
    { patch: { homePath: "\0" }, detail: "Invalid Codex SSH owner operand" },
    { patch: { sessionEpoch: -1 }, detail: "Invalid Codex SSH owner operand" },
    { patch: { configArgs: ["-c", "arbitrary=true"] }, detail: "typed launch recipe" },
  ])("rejects $patch before any owner operation", async ({ patch, detail }) => {
    const noLegacy = watchLegacyReadiness();
    const { owner } = fixture();
    await expect(
      startRemoteCodexAppServerProcessAsync({ ...input, ...patch }, undefined, { owner }),
    ).rejects.toThrow(detail);
    expect(owner.probeProvider).not.toHaveBeenCalled();
    expect(owner.startProvider).not.toHaveBeenCalled();
    noLegacy();
  });

  it("refuses selected sync or missing-owner calls without trying legacy readiness", async () => {
    const noLegacy = watchLegacyReadiness();
    const { owner } = fixture();
    expect(() => startRemoteCodexAppServerProcess(input)).toThrow(/asynchronous/);
    expect(() => startRemoteCodexAppServerProcess(input, { owner })).toThrow(/asynchronous/);
    await expect(
      assertSupportedRemoteCodexCliVersionAsync(input, { owner: undefined }),
    ).rejects.toThrow(/unavailable/);
    await expect(
      startRemoteCodexAppServerProcessAsync(input, undefined, { owner: undefined }),
    ).rejects.toThrow(/unavailable/);
    expect(owner.probeProvider).not.toHaveBeenCalled();
    expect(owner.startProvider).not.toHaveBeenCalled();
    noLegacy();
  });

  it.each([
    { result: { status: 127, stdout: "", stderr: "codex: not found" }, detail: /codex: not found/ },
    { result: { status: 0, stdout: "codex-cli 0.1.0", stderr: "" }, detail: /upgrade/i },
    {
      result: { status: 0, stdout: "", stderr: "é".repeat(REMOTE_CODEX_PROBE_MAX_BYTES / 2 + 1) },
      detail: /output limit/,
    },
  ])("does not launch on invalid probe outcome %#", async ({ result, detail }) => {
    const noLegacy = watchLegacyReadiness();
    const { owner } = fixture();
    owner.probeProvider.mockResolvedValue(result);
    await expect(
      startRemoteCodexAppServerProcessAsync(input, undefined, { owner }),
    ).rejects.toThrow(detail);
    expect(owner.startProvider).not.toHaveBeenCalled();
    noLegacy();
  });

  it("propagates a typed owner probe failure without fallback or relabeling", async () => {
    const noLegacy = watchLegacyReadiness();
    const { owner } = fixture();
    const lost = Object.assign(new Error("owner channel lost"), { code: "sshOwnerUnavailable" });
    owner.probeProvider.mockRejectedValue(lost);
    await expect(assertSupportedRemoteCodexCliVersionAsync(input, { owner })).rejects.toBe(lost);
    expect(owner.startProvider).not.toHaveBeenCalled();
    noLegacy();
  });

  it("bounds the owner probe even if it ignores abort", async () => {
    vi.useFakeTimers();
    const { owner } = fixture();
    const pending = Promise.withResolvers<typeof versionOutput>();
    owner.probeProvider.mockReturnValue(pending.promise);
    const start = startRemoteCodexAppServerProcessAsync(input, undefined, { owner });
    const rejected = expect(start).rejects.toThrow(/version check timed out/);
    await vi.advanceTimersByTimeAsync(REMOTE_CODEX_ASYNC_PROBE_TIMEOUT_MS);
    await rejected;
    expect(owner.probeProvider.mock.calls[0]?.[1].aborted).toBe(true);
    pending.resolve(versionOutput);
    await Promise.resolve();
    expect(owner.startProvider).not.toHaveBeenCalled();
  });

  it("skips a pre-aborted probe and suppresses start on cancellation during the probe", async () => {
    const { owner } = fixture();
    const stop = new Error("stop before launch");
    await expect(
      startRemoteCodexAppServerProcessAsync(input, AbortSignal.abort(stop), { owner }),
    ).rejects.toBe(stop);
    expect(owner.probeProvider).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = Promise.withResolvers<typeof versionOutput>();
    const dispatched = Promise.withResolvers<AbortSignal>();
    owner.probeProvider.mockImplementation((_scope, signal) => {
      dispatched.resolve(signal);
      return pending.promise;
    });
    const start = startRemoteCodexAppServerProcessAsync(input, controller.signal, { owner });
    const probeSignal = await dispatched.promise;
    controller.abort(stop);
    pending.resolve(versionOutput);
    await expect(start).rejects.toBe(stop);
    expect(probeSignal.aborted).toBe(true);
    expect(owner.startProvider).not.toHaveBeenCalled();
  });

  it("cancels only the pending reservation and waits for confirmation even if pipes arrive late", async () => {
    const reservation = fixture();
    const other = fixture();
    other.ready.resolve(other.pipes);
    const live = await startRemoteCodexAppServerProcessAsync(input, undefined, {
      owner: other.owner,
    });
    const controller = new AbortController();
    const confirmed = Promise.withResolvers<void>();
    reservation.cancelled.mockReturnValue(confirmed.promise);
    const start = startRemoteCodexAppServerProcessAsync(input, controller.signal, {
      owner: reservation.owner,
    });
    const stop = new Error("stop while acquiring pipes");
    const rejected = expect(start).rejects.toBe(stop);
    await reservation.dispatched.promise;
    controller.abort(stop);
    await vi.waitFor(() => expect(reservation.cancelled).toHaveBeenCalledTimes(1));
    reservation.ready.resolve(reservation.pipes);
    reservation.exit.reject(new Error("late transport loss"));
    confirmed.resolve();
    await rejected;
    expect(other.cancelled).not.toHaveBeenCalled();
    await Promise.all([live.cancel(), live.cancel()]);
    expect(other.cancelled).toHaveBeenCalledTimes(1);
  });

  it("bounds readiness and reports unconfirmed cancellation separately", async () => {
    vi.useFakeTimers();
    const { owner, cancelled } = fixture();
    cancelled.mockReturnValue(new Promise(() => {}));
    const start = startRemoteCodexAppServerProcessAsync(input, undefined, { owner });
    const rejected = expect(start).rejects.toMatchObject({
      message: expect.stringContaining("cleanup failed"),
      errors: [
        expect.objectContaining({
          message: expect.stringContaining("waiting for app-server pipes"),
        }),
        expect.objectContaining({ message: expect.stringContaining("could not confirm") }),
      ],
    });
    await vi.advanceTimersByTimeAsync(CODEX_OWNER_START_TIMEOUT_MS + CODEX_OWNER_CANCEL_TIMEOUT_MS);
    await rejected;
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
