import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";

import {
  InitiatingGitOwner,
  type ApprovedInitiatingGitPush,
  type InitiatingGitPushRequest,
} from "../Services/InitiatingGitOwner.ts";
import {
  effective,
  expectDenied,
  isLocalProbe,
  remoteName,
  setup,
} from "./GitCore.initiatingPush.test.fixture.ts";
import { git, TestLayer } from "./GitCore.test.helpers.ts";

it.layer(TestLayer)("initiating Git push selection", (it) => {
  it.effect("dispatches only typed approved operands from the product push path", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush, sourceOid, local, remote } = yield* setup();
      expect(yield* git(cwd, ["remote", "get-url", "--push", remoteName])).toBe(effective);
      const push = vi.fn(
        async (_request: InitiatingGitPushRequest, _signal: AbortSignal) => "pushed" as const,
      );
      const result = yield* core
        .pushCurrentBranch(cwd, "caller-fallback", "local", "caller-operation")
        .pipe(Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }));
      expect(result).toEqual({
        status: "pushed",
        branch: "local",
        upstreamBranch: `${remoteName}/tracked`,
        setUpstream: false,
      });
      expect(push).toHaveBeenCalledExactlyOnceWith(
        {
          direction: approvedPush.direction,
          repository: approvedPush.repository,
          remoteName,
          refs: approvedPush.refs,
          sourceOid,
          destinations: [
            {
              ...approvedPush.destination,
              effectiveUrl: effective,
              executionTargetId: approvedPush.executionTargetId,
              targetGeneration: approvedPush.targetGeneration,
            },
          ],
        },
        expect.any(AbortSignal),
      );
      expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
      expect(remote).not.toHaveBeenCalled();
    }),
  );

  it.effect("denies missing approval and missing owner before even inspecting Git", () =>
    Effect.gen(function* () {
      const { cwd, core, local, approvedPush } = yield* setup();
      const push = vi.fn(async () => "pushed" as const);
      for (const selection of [{ owner: { push } }, { approvedPush }]) {
        const result = yield* core
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.provideService(InitiatingGitOwner, selection), Effect.result);
        expectDenied(result, "selected without an available owner and approved push scope");
      }
      expect(push).not.toHaveBeenCalled();
      expect(local).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not substitute legacy Git for incomplete, rejected or unknown outcomes", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush, local } = yield* setup();
      for (const outcome of ["partial", "unknown", "denied", "rejectedRef", "lost"] as const) {
        const push = vi.fn(async () => {
          if (outcome === "lost") throw new Error("owner lost after dispatch");
          return outcome;
        });
        const result = yield* core
          .pushCurrentBranch(cwd, null)
          .pipe(
            Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }),
            Effect.result,
          );
        expectDenied(
          result,
          outcome === "denied"
            ? "denied"
            : outcome === "rejectedRef"
              ? "ref was rejected"
              : "Verify the remote state",
        );
        expect(push).toHaveBeenCalledTimes(1);
      }
      expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
    }),
  );

  it.effect("signals cancellation on timeout and does not retry an uncertain write", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush, local } = yield* setup();
      const started = Promise.withResolvers<AbortSignal>();
      const push = vi.fn((_request: InitiatingGitPushRequest, signal: AbortSignal) => {
        started.resolve(signal);
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const fiber = yield* core
        .pushCurrentBranch(cwd, null)
        .pipe(
          Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }),
          Effect.result,
          Effect.forkChild,
        );
      const signal = yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("30 seconds");
      expectDenied(yield* Fiber.join(fiber), "timed out. Verify the remote state");
      expect(signal.aborted).toBe(true);
      expect(push).toHaveBeenCalledTimes(1);
      expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
    }),
  );

  it.effect("denies a changed destination or any sibling push destination before dispatch", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush, local } = yield* setup();
      const push = vi.fn(async () => "pushed" as const);
      const selected = core
        .pushCurrentBranch(cwd, null)
        .pipe(
          Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }),
          Effect.result,
        );
      yield* git(cwd, [
        "config",
        "--add",
        `remote.${remoteName}.pushurl`,
        "https://write.invalid/sibling.git",
      ]);
      expectDenied(yield* selected, "complete approved effective SSH URL list");
      yield* git(cwd, [
        "config",
        "--replace-all",
        `remote.${remoteName}.pushurl`,
        effective.replace("project.git", "other.git"),
      ]);
      expectDenied(yield* selected, "complete approved effective SSH URL list");
      expect(push).not.toHaveBeenCalled();
      expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
    }),
  );

  it.effect("binds legacy approval to one canonical spelling, not all endpoint aliases", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush } = yield* setup();
      const defaultPortApproval = {
        ...approvedPush,
        executionTargetId: "ssh:host=push.invalid&user=git",
        destination: { ...approvedPush.destination, port: 22 },
      };
      const push = vi.fn(async (_request: InitiatingGitPushRequest) => "pushed" as const);
      const selected = core.pushCurrentBranch(cwd, null).pipe(
        Effect.provideService(InitiatingGitOwner, {
          approvedPush: defaultPortApproval,
          owner: { push },
        }),
      );
      const key = `remote.${remoteName}.pushurl`;
      yield* git(cwd, ["config", "--replace-all", key, effective.replace(":2222/", ":22/")]);
      expectDenied(yield* Effect.result(selected), "complete approved effective SSH URL list");
      expect(push).not.toHaveBeenCalled();
      const canonicalUrl = effective.replace(":2222/", "/");
      yield* git(cwd, ["config", "--replace-all", key, canonicalUrl]);
      expect((yield* selected).status).toBe("pushed");
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0]?.[0].destinations[0].effectiveUrl).toBe(canonicalUrl);
    }),
  );

  it.effect("denies foreign repositories, mismatched refs, and untracked or widening pushes", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush, local } = yield* setup();
      const push = vi.fn(async () => "pushed" as const);
      const selected = (scope: ApprovedInitiatingGitPush) =>
        core
          .pushCurrentBranch(cwd, null)
          .pipe(
            Effect.provideService(InitiatingGitOwner, { approvedPush: scope, owner: { push } }),
            Effect.result,
          );
      expectDenied(
        yield* selected({
          ...approvedPush,
          repository: { ...approvedPush.repository, commonDir: cwd },
        }),
        "repository does not match",
      );
      expectDenied(
        yield* selected({
          ...approvedPush,
          refs: { ...approvedPush.refs, destination: "refs/heads/foreign" },
        }),
        "remote/ref is unknown",
      );
      yield* git(cwd, ["config", "push.followTags", "true"]);
      expectDenied(yield* selected(approvedPush), "outside the approved scope");
      yield* git(cwd, ["config", "--unset", "branch.local.merge"]);
      expectDenied(yield* selected(approvedPush), "remote/ref is unknown");
      expect(push).not.toHaveBeenCalled();
      expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
    }),
  );

  it.effect("leaves unselected local and remote-workspace routing alone", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush, local, remote } = yield* setup();
      const push = vi.fn(async () => "pushed" as const);
      expectDenied(
        yield* Effect.result(core.pushCurrentBranch(cwd, null)),
        "Fixture forbids legacy commands",
      );
      expect(local.mock.calls.some(([input]) => !isLocalProbe(input))).toBe(true);
      local.mockClear();
      const executionTargetId = "ssh:workspace.invalid";
      const result = yield* core
        .pushCurrentBranch(cwd, null, executionTargetId)
        .pipe(
          Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }),
          Effect.result,
        );
      expectDenied(result, "Fixture forbids legacy commands");
      expect(
        remote.mock.calls.some(([input]) => input.executionTargetId === executionTargetId),
      ).toBe(true);
      expect(local).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    }),
  );
});
