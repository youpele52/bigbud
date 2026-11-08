import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectExecutionTargetEffect,
  disconnectExecutionTargetEffect,
  listDisconnectedExecutionTargetsEffect,
  type RemoteDisconnectStep,
  RemoteDisconnectStepError,
} from "./wsRemoteConnection.ts";
import {
  clearSshTargetDisconnected,
  configureSshTargetDisconnects,
  isSshTargetDisconnected,
  RemoteTargetDisconnectedError,
  type SshTargetDisconnectStore,
} from "../ssh/sshTargetDisconnects.ts";

const target = "ssh:host=box&auth=ssh-key&transport=agent";

function durableStore(overrides: Partial<SshTargetDisconnectStore> = {}) {
  return {
    persist: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...overrides,
  } satisfies SshTargetDisconnectStore;
}

function recordingSteps(events: string[], failing?: string): ReadonlyArray<RemoteDisconnectStep> {
  return ["provider-sessions", "direct-ssh-terminals", "remote-agent", "password", "monitor"].map(
    (name) => ({
      name,
      run: (executionTargetId, error) =>
        Effect.suspend(() => {
          // Every step runs only after the guard is already in force, with the guard error.
          const guarded = error instanceof RemoteTargetDisconnectedError;
          events.push(`${name}:${isSshTargetDisconnected(executionTargetId) && guarded}`);
          return name === failing
            ? Effect.fail(new RemoteDisconnectStepError({ step: name, cause: "boom" }))
            : Effect.void;
        }),
    }),
  );
}

afterEach(() => configureSshTargetDisconnects(undefined, []));

describe("remote workspace disconnect action", () => {
  it("persists first, then tears down every holder in order, continuing past failures", async () => {
    const store = durableStore();
    configureSshTargetDisconnects(store, []);
    const events: string[] = [];

    const result = await Effect.runPromise(
      disconnectExecutionTargetEffect(
        { executionTargetId: target },
        recordingSteps(events, "direct-ssh-terminals"),
      ),
    );

    expect(result).toEqual({ executionTargetId: target, disconnected: true });
    expect(store.persist).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "provider-sessions:true",
      "direct-ssh-terminals:true",
      "remote-agent:true",
      "password:true",
      "monitor:true",
    ]);
    await expect(Effect.runPromise(listDisconnectedExecutionTargetsEffect())).resolves.toEqual({
      executionTargetIds: [target],
    });
  });

  it("is idempotent: a repeat keeps the flag and reruns the bounded teardown", async () => {
    const store = durableStore();
    configureSshTargetDisconnects(store, []);
    const events: string[] = [];
    const steps = recordingSteps(events);
    await Effect.runPromise(disconnectExecutionTargetEffect({ executionTargetId: target }, steps));
    await expect(
      Effect.runPromise(disconnectExecutionTargetEffect({ executionTargetId: target }, steps)),
    ).resolves.toEqual({ executionTargetId: target, disconnected: true });
    expect(store.persist).toHaveBeenCalledOnce();
    expect(events).toHaveLength(10);
  });

  it("returns an error and changes nothing when the flag cannot be saved", async () => {
    configureSshTargetDisconnects(
      durableStore({ persist: vi.fn(async () => Promise.reject(new Error("disk full"))) }),
      [],
    );
    const events: string[] = [];
    const exit = await Effect.runPromiseExit(
      disconnectExecutionTargetEffect({ executionTargetId: target }, recordingSteps(events)),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("ServerRemoteConnectionError");
    expect(events).toEqual([]);
    expect(isSshTargetDisconnected(target)).toBe(false);
  });

  it("stops the teardown when a Connect lands part-way through", async () => {
    configureSshTargetDisconnects(durableStore(), []);
    const events: string[] = [];
    const steps = [...recordingSteps(events)];
    // The user presses Connect while the terminal step runs.
    const terminals = steps[1]!;
    steps[1] = {
      name: terminals.name,
      run: (id, error) =>
        terminals
          .run(id, error)
          .pipe(Effect.andThen(Effect.promise(() => clearSshTargetDisconnected(id)))),
    };

    await expect(
      Effect.runPromise(disconnectExecutionTargetEffect({ executionTargetId: target }, steps)),
    ).resolves.toEqual({ executionTargetId: target, disconnected: true });
    expect(events).toEqual(["provider-sessions:true", "direct-ssh-terminals:true"]);
    expect(isSshTargetDisconnected(target)).toBe(false);
  });

  it("rejects targets that are not SSH workspaces", async () => {
    const exit = await Effect.runPromiseExit(
      disconnectExecutionTargetEffect({ executionTargetId: "local" }, recordingSteps([])),
    );
    expect(exit._tag).toBe("Failure");
    expect(isSshTargetDisconnected("local")).toBe(false);
  });
});

describe("remote workspace connect action", () => {
  it("clears the persisted flag before waking reattach, and repeats harmlessly", async () => {
    const order: string[] = [];
    const store = durableStore({
      remove: vi.fn(async () => {
        order.push("remove");
      }),
    });
    configureSshTargetDisconnects(store, [target]);
    const wake = vi.fn(() => {
      order.push(`wake:${isSshTargetDisconnected(target)}`);
    });

    await expect(
      Effect.runPromise(connectExecutionTargetEffect({ executionTargetId: target }, wake)),
    ).resolves.toEqual({ executionTargetId: target, disconnected: false });
    await Effect.runPromise(connectExecutionTargetEffect({ executionTargetId: target }, wake));

    expect(order).toEqual(["remove", "wake:false", "wake:false"]);
    expect(store.remove).toHaveBeenCalledOnce();
  });

  it("stays disconnected when clearing the flag fails", async () => {
    configureSshTargetDisconnects(
      durableStore({ remove: vi.fn(async () => Promise.reject(new Error("locked"))) }),
      [target],
    );
    const wake = vi.fn();
    const exit = await Effect.runPromiseExit(
      connectExecutionTargetEffect({ executionTargetId: target }, wake),
    );
    expect(exit._tag).toBe("Failure");
    expect(wake).not.toHaveBeenCalled();
    expect(isSshTargetDisconnected(target)).toBe(true);
  });
});
