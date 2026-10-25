import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vitest";
import {
  TerminalCwdError,
  TerminalExecutionTargetError,
} from "@bigbud/contracts/workspace/terminal.ts";
import {
  expandTerminalHome,
  makeResolveTerminalFolder,
  type TerminalFolderInput,
} from "./Manager.cwd";

const input: TerminalFolderInput = {
  threadId: "draft",
  terminalId: "bottom",
  executionTargetId: "local",
  cwd: "/project",
};
const missing = (cwd: string) => Effect.fail(new TerminalCwdError({ cwd, reason: "notFound" }));

describe("terminal folder selection", () => {
  it.effect("keeps valid intended folders without waiting or probing Home", () =>
    Effect.gen(function* () {
      const visited: string[] = [];
      const resolve = makeResolveTerminalFolder(
        (cwd) =>
          Effect.sync(() => {
            visited.push(cwd);
          }),
        undefined,
        () => "/home/target",
      );
      expect(yield* resolve(input)).toEqual({ cwd: "/project" });
      expect(visited).toEqual(["/project"]);
    }),
  );

  it.effect(
    "falls back immediately for missing and inaccessible folders, including global defaults",
    () =>
      Effect.gen(function* () {
        for (const reason of ["notFound", "notDirectory", "statFailed"] as const) {
          const visited: string[] = [];
          const resolve = makeResolveTerminalFolder(
            (cwd) => {
              visited.push(cwd);
              return cwd === "/home/target"
                ? Effect.void
                : Effect.fail(new TerminalCwdError({ cwd, reason }));
            },
            undefined,
            () => "/home/target",
          );
          const result = yield* resolve({ ...input, cwd: "~/Documents" });
          expect(result.cwd).toBe("/home/target");
          expect(result.directoryFallback?.requestedCwd).toBe("~/Documents");
          expect(visited).toEqual(["/home/target/Documents", "/home/target"]);
        }
      }),
  );

  it.effect("chooses Home at ten seconds and ignores the late primary result", () =>
    Effect.gen(function* () {
      const late = yield* Deferred.make<void>();
      const visited: string[] = [];
      const resolve = makeResolveTerminalFolder(
        (cwd) => {
          visited.push(cwd);
          return cwd === "/project" ? Deferred.await(late) : Effect.void;
        },
        undefined,
        () => "/home/target",
      );
      const fiber = yield* resolve(input).pipe(Effect.forkChild);
      yield* TestClock.adjust(9999);
      expect(visited).toEqual(["/project"]);
      yield* TestClock.adjust(1);
      expect((yield* Fiber.join(fiber)).cwd).toBe("/home/target");
      yield* Deferred.succeed(late, undefined);
      expect(visited).toEqual(["/project", "/home/target"]);
    }),
  );

  it.effect("bounds the Home probe and fails actionably without another retry", () =>
    Effect.gen(function* () {
      let calls = 0;
      const resolve = makeResolveTerminalFolder(
        (cwd) => {
          calls++;
          return cwd === "/project" ? missing(cwd) : Effect.never;
        },
        undefined,
        () => "/home/target",
      );
      const fiber = yield* Effect.result(resolve(input)).pipe(Effect.forkChild);
      yield* TestClock.adjust(10000);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "TerminalExecutionTargetError" },
      });
      expect(calls).toBe(2);
    }),
  );

  it.effect(
    "includes runtime path identity capture in the same ten-second directory deadline",
    () =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const resolve = makeResolveTerminalFolder(
          () => Effect.void,
          undefined,
          () => "/home/target",
          (cwd) => {
            paths.push(cwd);
            return cwd === "/project/worktree"
              ? Effect.never
              : Effect.succeed({ canonicalPath: cwd, device: 1, inode: 2 });
          },
        );
        const fiber = yield* resolve({ ...input, worktreePath: "/project/worktree" }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust(10000);
        const folder = yield* Fiber.join(fiber);
        expect(folder.cwd).toBe("/home/target");
        expect(folder.runtimePathIdentity?.canonicalPath).toBe("/home/target");
        expect(paths).toEqual(["/project/worktree", "/home/target"]);
      }),
  );

  it.effect("uses the SSH user's Home, never the server's Home", () =>
    Effect.gen(function* () {
      const probe = vi.fn((target: TerminalFolderInput, home: boolean) =>
        home ? Effect.succeed("/home/remote-user") : missing(target.cwd),
      );
      const local = vi.fn(() => Effect.void);
      const resolve = makeResolveTerminalFolder(local, probe, () => "/home/server-user");
      const target = { ...input, executionTargetId: "ssh:host=devbox&user=deploy&auth=ssh-key" };
      expect((yield* resolve(target)).cwd).toBe("/home/remote-user");
      expect(local).not.toHaveBeenCalled();
      expect(probe.mock.calls.map(([value, home]) => [value.executionTargetId, home])).toEqual([
        [target.executionTargetId, false],
        [target.executionTargetId, true],
      ]);
    }),
  );

  it.effect("does not apply directory fallback to target connection errors", () =>
    Effect.gen(function* () {
      const probe = vi.fn((target: TerminalFolderInput) =>
        Effect.fail(new TerminalExecutionTargetError({ ...target, detail: "offline" })),
      );
      const resolve = makeResolveTerminalFolder(() => Effect.void, probe);
      const failure = yield* Effect.flip(
        resolve({ ...input, executionTargetId: "ssh:host=devbox&user=deploy&auth=ssh-key" }),
      );
      expect(failure._tag).toBe("TerminalExecutionTargetError");
      expect(probe).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    "falls back for a stalled remote folder only after the target confirms connection",
    () =>
      Effect.gen(function* () {
        const probe = vi.fn((_target: TerminalFolderInput, home: boolean, ready?: () => void) => {
          ready?.();
          return home ? Effect.succeed("/home/remote-user") : Effect.never;
        });
        const resolve = makeResolveTerminalFolder(() => Effect.void, probe);
        const fiber = yield* resolve({
          ...input,
          executionTargetId: "ssh:host=devbox&user=deploy&auth=ssh-key",
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust(10000);
        expect((yield* Fiber.join(fiber)).cwd).toBe("/home/remote-user");
        expect(probe).toHaveBeenCalledTimes(2);
      }),
  );

  it.effect("does not attempt Home when the target connection itself stalls", () =>
    Effect.gen(function* () {
      const probe = vi.fn(() => Effect.never);
      const resolve = makeResolveTerminalFolder(() => Effect.void, probe);
      const fiber = yield* Effect.flip(
        resolve({ ...input, executionTargetId: "ssh:host=devbox&user=deploy&auth=ssh-key" }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(10000);
      expect((yield* Fiber.join(fiber))._tag).toBe("TerminalExecutionTargetError");
      expect(probe).toHaveBeenCalledOnce();
    }),
  );

  it("expands Unix and Windows home prefixes without changing Documents to Home", () => {
    expect(expandTerminalHome("~/Documents", "/home/user", "linux")).toBe("/home/user/Documents");
    expect(expandTerminalHome("~\\Documents", "C:\\Users\\user", "win32")).toBe(
      "C:\\Users\\user\\Documents",
    );
    expect(expandTerminalHome("~", "C:\\Users\\user", "win32")).toBe("C:\\Users\\user");
  });
});
