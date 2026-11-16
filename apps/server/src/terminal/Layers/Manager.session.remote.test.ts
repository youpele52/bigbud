import * as Owners from "../../remote-agent/remoteAgentOwners";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeRemoteTerminalApi } from "./Manager.session.remote";
import { createTerminalSessionState } from "./Manager.session.state";
import type { SessionApiContext } from "./Manager.session.types";
import type { makeTerminalOpen } from "./Manager.session.open";
import type { PtyProcess } from "../Services/PTY";
import { toSessionKey } from "./Manager.shell";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import { ownedRuntimeFixture } from "./Manager.owned-runtime.test.helpers.ts";
import { RemoteAgentPtyInventory } from "../../remote-agent/remoteAgentPtyInventory.ts";

function fixture(options: { target?: string; rejected?: boolean; runtime?: OwnedPtyRuntime } = {}) {
  const session = createTerminalSessionState({
    threadId: "thread",
    terminalId: "terminal",
    executionTargetId: options.target ?? "ssh:host=test&transport=agent",
    dropPathMode: "posix",
    cwd: "/work",
    worktreePath: null,
    history: "retained",
    cols: 80,
    rows: 24,
    runtimeEnv: null,
  });
  const detachRemote = vi.fn(async () => {
    if (options.rejected) throw new Error("lost reply");
  });
  const kill = vi.fn();
  session.process = { pid: 42, detachRemote, kill } as unknown as PtyProcess;
  session.status = "running";
  session.pid = 42;
  const other = { ...session, terminalId: "other" };
  let state = {
    sessions: new Map([
      [toSessionKey("thread", "terminal"), session],
      [toSessionKey("thread", "other"), other],
    ]),
    killFibers: new Map(),
  };
  const persistHistory = vi.fn(() => Effect.void);
  const releaseWorktreeLease = vi.fn(() => Effect.void);
  const publishEvent = vi.fn(() => Effect.void);
  const ctx = {
    ...(options.runtime
      ? {
          resolveOwnedRuntime: (target: string) =>
            target === "local" ? options.runtime : undefined,
        }
      : {}),
    withThreadLock: (_: string, effect: Effect.Effect<unknown>) => effect,
    getSession: (_: string, id: string) =>
      Effect.sync(() => Option.fromNullishOr(state.sessions.get(toSessionKey("thread", id)))),
    flushPtyOutput: () => Effect.void,
    flushPersist: () => Effect.void,
    persistHistory,
    releaseWorktreeLease,
    publishEvent,
    modifyManagerState: (change: (value: typeof state) => readonly [unknown, typeof state]) =>
      Effect.sync(() => {
        const [result, next] = change(state);
        state = next;
        return result;
      }),
  } as unknown as SessionApiContext;
  const open = vi.fn(() => Effect.succeed({})) as unknown as ReturnType<typeof makeTerminalOpen>;
  const close = vi.fn(() => Effect.void);
  const api = makeRemoteTerminalApi(ctx, open, close);
  return {
    session,
    state: () => state,
    api,
    detachRemote,
    kill,
    persistHistory,
    releaseWorktreeLease,
    publishEvent,
    open,
    close,
  };
}

describe("explicit persistent Detach", () => {
  it("waits for acknowledgement, preserves history/leases, and leaves the other terminal alone", async () => {
    const f = fixture();
    await Effect.runPromise(
      f.api.remoteDetach({
        threadId: "thread",
        terminalId: "terminal",
        expectedGeneration: f.session.runtimeGeneration,
      }),
    );
    expect(f.detachRemote).toHaveBeenCalledOnce();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.persistHistory).toHaveBeenCalledWith("thread", "terminal", "retained");
    expect(f.releaseWorktreeLease).not.toHaveBeenCalled();
    expect(f.publishEvent).not.toHaveBeenCalled();
    expect([...f.state().sessions.values()].map((s) => s.terminalId)).toEqual(["other"]);
    await Effect.runPromise(
      f.api.remoteDetach({
        threadId: "thread",
        terminalId: "terminal",
        expectedGeneration: f.session.runtimeGeneration,
      }),
    );
    expect(f.detachRemote).toHaveBeenCalledOnce();
  });
  it("keeps the session and recovery evidence on an uncertain detach", async () => {
    const f = fixture({ rejected: true });
    await expect(
      Effect.runPromise(
        f.api.remoteDetach({
          threadId: "thread",
          terminalId: "terminal",
          expectedGeneration: f.session.runtimeGeneration,
        }),
      ),
    ).rejects.toThrow("could not be confirmed");
    expect(f.state().sessions.size).toBe(2);
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.releaseWorktreeLease).not.toHaveBeenCalled();
  });
  it("refuses stale generations and non-agent terminals before transport mutation", async () => {
    for (const target of ["local", "ssh:host=test&transport=agent"]) {
      const f = fixture({ target });
      await expect(
        Effect.runPromise(
          f.api.remoteDetach({
            threadId: "thread",
            terminalId: "terminal",
            expectedGeneration: target === "local" ? f.session.runtimeGeneration : "old",
          }),
        ),
      ).rejects.toThrow();
      expect(f.detachRemote).not.toHaveBeenCalled();
      expect(f.kill).not.toHaveBeenCalled();
    }
  });
  it("routes explicit attachment through the observed resource fence", async () => {
    const f = fixture();
    const input = {
      threadId: "thread",
      terminalId: "terminal",
      executionTargetId: f.session.executionTargetId,
      resourceId: "observed-pty",
      cwd: "/work",
    };
    await Effect.runPromise(f.api.remoteAttach(input));
    expect(f.open).toHaveBeenCalledWith(input, "observed-pty");
  });
});

describe("authority-scoped local terminal discovery and control", () => {
  function localFixture() {
    const ownership = ownedRuntimeFixture();
    const f = fixture({ target: "local", runtime: ownership.runtime });
    const retained = {
      ...profileOwner(),
      ownerKey: `terminal:${JSON.stringify(["thread", "terminal"])}`,
      target: ownership.runtime.targetId,
      resourceId: "observed-pty",
      terminalCwd: "/work",
    };
    ownership.rows.set(retained.ownerKey, retained);
    const input = {
      threadId: "thread",
      terminalId: "terminal",
      executionTargetId: "local",
      resourceId: retained.resourceId,
      cwd: "/work",
    };
    return { ...f, ownership, retained, input };
  }

  it("queries the internal authority runtime but projects inventory back to UI local", async () => {
    const f = localFixture();
    const inventory = vi.spyOn(RemoteAgentPtyInventory.prototype, "list").mockResolvedValue([
      {
        ptyId: f.retained.resourceId,
        requestDigest: Buffer.from(f.retained.digest, "hex"),
        state: "running",
        pid: 42,
        nextSequence: 1,
        firstRetainedSequence: 0,
        verifiedExit: false,
        launchStatus: "unconfirmed",
      },
    ]);
    const result = await Effect.runPromise(f.api.remoteInventory({ executionTargetId: "local" }));
    expect(result.sessions).toMatchObject([
      {
        executionTargetId: "local",
        resourceId: f.retained.resourceId,
        epoch: f.retained.epoch,
        status: "running",
        pid: 42,
      },
    ]);
    expect(inventory).toHaveBeenCalledExactlyOnceWith(
      f.ownership.runtime.targetId,
      {
        runtime: f.retained.runtime,
        expectedEpoch: f.retained.epoch,
        connectionId: f.retained.connectionId,
      },
      expect.any(AbortSignal),
    );
  });

  it("preserves the observed resource and generation fence for local Stop", async () => {
    const f = localFixture();
    vi.mocked(f.open).mockReturnValue(
      Effect.succeed({
        threadId: "thread",
        terminalId: "terminal",
        runtimeGeneration: "local-attached-generation",
      } as TerminalSessionSnapshot),
    );
    await Effect.runPromise(f.api.remoteStop(f.input));
    expect(f.open).toHaveBeenCalledWith(f.input, f.retained.resourceId);
    expect(f.close).toHaveBeenCalledWith({
      threadId: "thread",
      terminalId: "terminal",
      expectedGeneration: "local-attached-generation",
    });
    f.ownership.rows.set(f.retained.ownerKey, {
      ...f.retained,
      target: `remote-backend:${"b".repeat(32)}`,
    });
    vi.mocked(f.open).mockClear();
    f.close.mockClear();
    await expect(Effect.runPromise(f.api.remoteStop(f.input))).rejects.toThrow("ownership changed");
    expect(f.open).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("acknowledges local Detach without killing or releasing the same-host lease/owner", async () => {
    const f = localFixture();
    await Effect.runPromise(
      f.api.remoteDetach({
        threadId: "thread",
        terminalId: "terminal",
        expectedGeneration: f.session.runtimeGeneration,
      }),
    );
    expect(f.detachRemote).toHaveBeenCalledOnce();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.releaseWorktreeLease).not.toHaveBeenCalled();
    expect(f.ownership.rows.get(f.retained.ownerKey)).toBe(f.retained);
    expect(f.persistHistory).toHaveBeenCalledWith("thread", "terminal", "retained");
  });
});

afterEach(() => vi.restoreAllMocks());
describe("explicit resource-fenced Stop", () => {
  const input = {
    threadId: "thread",
    terminalId: "terminal",
    executionTargetId: "ssh:host=test&transport=agent",
    resourceId: "observed-pty",
    cwd: "/work",
  };
  function owner(state: "dispatched" | "terminal" = "dispatched", resourceId = input.resourceId) {
    const retained = { ...profileOwner(), state, resourceId, target: input.executionTargetId };
    vi.spyOn(Owners, "remoteAgentOwners").mockReturnValue({
      get: async () => retained,
    } as unknown as Owners.RemoteAgentOwnerStore);
  }
  it("refuses stale inventory before attachment or shutdown", async () => {
    owner("dispatched", "replacement");
    const f = fixture();
    await expect(Effect.runPromise(f.api.remoteStop(input))).rejects.toThrow("ownership changed");
    expect(f.open).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });
  it("returns an already verified terminal receipt without attaching", async () => {
    owner("terminal");
    const f = fixture();
    await Effect.runPromise(f.api.remoteStop(input));
    expect(f.open).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });
  it("uses attach-only identity then the returned generation for confirmed shutdown", async () => {
    owner();
    const f = fixture();
    vi.mocked(f.open).mockReturnValue(
      Effect.succeed({
        threadId: "thread",
        terminalId: "terminal",
        runtimeGeneration: "attached-generation",
      } as TerminalSessionSnapshot),
    );
    await Effect.runPromise(f.api.remoteStop(input));
    expect(f.open).toHaveBeenCalledWith(input, input.resourceId);
    expect(f.close).toHaveBeenCalledWith({
      threadId: "thread",
      terminalId: "terminal",
      expectedGeneration: "attached-generation",
    });
  });
});
