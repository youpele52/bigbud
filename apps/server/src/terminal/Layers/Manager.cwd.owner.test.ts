import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, expect, vi } from "vitest";
import {
  markSshTargetDisconnected,
  clearSshTargetDisconnected,
} from "../../ssh/sshTargetDisconnects.ts";
import { makeResolveTerminalFolder } from "./Manager.cwd.ts";
import type { DirectSshTerminalCwdOwner } from "./Manager.cwd.owner.ts";

const target = "ssh:host=terminal-cwd.test&user=deploy&transport=direct-ssh";
const input = {
  executionTargetId: target,
  threadId: "thread",
  terminalId: "pane",
  cwd: "/work/a 'quoted' $folder",
  worktreePath: "/not/the/probe",
  env: { PATH: "/not/forwarded" },
};

function fixture(probe: DirectSshTerminalCwdOwner["probeCwd"]) {
  const probeCwd = vi.fn(probe);
  const local = vi.fn(() => Effect.void);
  const legacy = vi.fn(() => Effect.succeed("/legacy"));
  const resolve = makeResolveTerminalFolder(local, legacy, () => "/server-home", undefined, {
    probeCwd,
  });
  return { resolve, probeCwd, local, legacy };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it.effect("passes only the exact direct SSH target and cwd operands to the owner", () =>
  Effect.gen(function* () {
    const { resolve, probeCwd, legacy, local } = fixture(async () => ({
      kind: "resolved",
      cwd: "/canonical",
    }));
    expect(yield* resolve(input)).toEqual({ cwd: "/canonical" });
    expect(probeCwd).toHaveBeenCalledExactlyOnceWith(
      { executionTargetId: target, cwd: input.cwd, home: false },
      expect.any(AbortSignal),
    );
    expect(legacy).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  }),
);

it.effect("uses the same captured owner for verified no-folder and Home", () =>
  Effect.gen(function* () {
    const executionTargetId = "ssh:legacy-terminal-cwd.test";
    vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "direct-ssh");
    const { resolve, probeCwd, legacy, local } = fixture(async ({ home }) => {
      // Transport selection must not run again for Home.
      vi.stubEnv("BIGBUD_REMOTE_AGENT_TRANSPORT", "agent");
      return home ? { kind: "resolved", cwd: "/remote-home" } : { kind: "noFolder" };
    });
    expect(yield* resolve({ ...input, executionTargetId })).toEqual({
      cwd: "/remote-home",
      directoryFallback: {
        requestedCwd: input.cwd,
        reason: "The requested folder is inaccessible",
      },
    });
    expect(probeCwd.mock.calls.map(([request]) => request)).toEqual([
      { executionTargetId, cwd: input.cwd, home: false },
      { executionTargetId, cwd: input.cwd, home: true },
    ]);
    expect(legacy).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  }),
);

it.effect(
  "keeps local cwd validation local and routes agent-transport SSH targets through the owner",
  () =>
    Effect.gen(function* () {
      const { resolve, probeCwd, legacy, local } = fixture(async ({ cwd }) => ({
        kind: "resolved",
        cwd,
      }));
      const agent = target.replace("direct-ssh", "agent");
      expect(yield* resolve({ ...input, executionTargetId: "local" })).toEqual({ cwd: input.cwd });
      expect(yield* resolve({ ...input, executionTargetId: agent })).toMatchObject({
        cwd: input.cwd,
      });
      expect(local).toHaveBeenCalledExactlyOnceWith(input.cwd);
      expect(legacy).not.toHaveBeenCalled();
      expect(probeCwd).toHaveBeenCalledExactlyOnceWith(
        { executionTargetId: agent, cwd: input.cwd, home: false },
        expect.anything(),
      );
    }),
);

it.effect("fails closed on owner denial or an invalid resolved path", () =>
  Effect.gen(function* () {
    const denied = fixture(async () => {
      throw new Error("WorkspacePathDenied");
    });
    const invalid = fixture(async () => ({ kind: "resolved", cwd: "relative" }));
    for (const { resolve, probeCwd, legacy, local } of [denied, invalid]) {
      expect(yield* Effect.flip(resolve(input))).toMatchObject({
        _tag: "TerminalExecutionTargetError",
        executionTargetId: target,
      });
      expect(probeCwd).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
      expect(local).not.toHaveBeenCalled();
    }
  }),
);

it.effect("fails closed when the owner denies Home after a verified no-folder result", () =>
  Effect.gen(function* () {
    const { resolve, probeCwd, legacy, local } = fixture(async ({ home }) => {
      if (home) throw new Error("WorkspacePathDenied");
      return { kind: "noFolder" };
    });
    expect(yield* Effect.flip(resolve(input))).toMatchObject({
      _tag: "TerminalExecutionTargetError",
      executionTargetId: target,
    });
    expect(probeCwd.mock.calls.map(([request]) => request.home)).toEqual([false, true]);
    expect(legacy).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  }),
);

it.effect("bounds the selected owner probe and aborts it without retrying on timeout", () =>
  Effect.gen(function* () {
    const { resolve, probeCwd, legacy } = fixture(() => new Promise(() => {}));
    const fiber = yield* Effect.flip(resolve(input)).pipe(Effect.forkChild);
    yield* TestClock.adjust(9999);
    const signal = probeCwd.mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    yield* TestClock.adjust(1);
    expect((yield* Fiber.join(fiber))._tag).toBe("TerminalExecutionTargetError");
    expect(signal?.aborted).toBe(true);
    expect(probeCwd).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  }),
);

it.effect("refuses invalid paths and explicitly disconnected targets before owner dispatch", () =>
  Effect.gen(function* () {
    const { resolve, probeCwd, legacy } = fixture(async () => ({ kind: "noFolder" }));
    expect((yield* Effect.flip(resolve({ ...input, cwd: "/invalid\0path" })))._tag).toBe(
      "TerminalExecutionTargetError",
    );
    yield* Effect.promise(() => markSshTargetDisconnected(target));
    const error = yield* Effect.flip(resolve(input)).pipe(
      Effect.ensuring(Effect.promise(() => clearSshTargetDisconnected(target))),
    );
    expect(error._tag).toBe("TerminalExecutionTargetError");
    expect(probeCwd).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  }),
);
