import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { expect, vi } from "vitest";

import {
  makeIsolatedInitiatingGitOwnerLayer,
  makeIsolatedInitiatingGitPush,
  type BoundedInitiatingGitTransport,
  type IsolatedInitiatingPushApproval,
  type TrackedReceiveReceipt,
} from "./GitCore.initiatingPush.composition.ts";
import { pushInitiatingBranch } from "./GitCore.initiatingPush.ts";
import {
  effective,
  expectDenied,
  isLocalProbe,
  remoteName,
  setup,
} from "./GitCore.initiatingPush.test.fixture.ts";
import { git, TestLayer } from "./GitCore.test.helpers.ts";

type Receive = BoundedInitiatingGitTransport["receiveTrackedPush"];
const old = "1".repeat(40);
const mirrorOld = "2".repeat(40);
const mirror = {
  effectiveUrl: "ssh://git@other.invalid/another.git",
  executionTargetId: "ssh:host=other.invalid&user=git",
  targetGeneration: "other-generation",
  expectedOldOid: mirrorOld,
};
const pushUrlKey = `remote.${remoteName}.pushurl`;

const setupProduct = Effect.fn("setupInitiatingPushCompositionTest")(function* () {
  const { cwd, approvedPush, sourceOid, local, remote } = yield* setup();
  yield* git(cwd, ["config", "--add", pushUrlKey, mirror.effectiveUrl]);
  const { direction, repository, refs, executionTargetId, targetGeneration } = approvedPush;
  const first = {
    effectiveUrl: effective,
    executionTargetId,
    targetGeneration,
    expectedOldOid: old,
  };
  const approval = {
    direction,
    repository,
    remoteName,
    refs,
    sourceOid,
    destinations: [first, mirror],
  } as const satisfies IsolatedInitiatingPushApproval;
  const expectOnlyLocalProbes = () => {
    expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
    expect(remote).not.toHaveBeenCalled();
  };
  return { cwd, local, approval, first, expectOnlyLocalProbes };
});

function receipt(
  scope: IsolatedInitiatingPushApproval["destinations"][number],
  index: number,
  outcome: TrackedReceiveReceipt["outcome"],
): TrackedReceiveReceipt {
  const { effectiveUrl, executionTargetId, targetGeneration } = scope;
  return { index, effectiveUrl, executionTargetId, targetGeneration, outcome };
}

it.layer(TestLayer)("isolated initiating Git push composition", (it) => {
  it.effect(
    "submits one bounded request for the exact rewritten destinations and duplicate slots",
    () =>
      Effect.gen(function* () {
        const { cwd, local, approval, first, expectOnlyLocalProbes } = yield* setupProduct();
        yield* git(cwd, ["config", "--add", pushUrlKey, effective]);
        yield* git(cwd, ["config", "core.sshCommand", "must-not-run-ambient-ssh"]);
        const duplicate = { ...first, expectedOldOid: approval.sourceOid };
        const receiveTrackedPush = vi.fn<Receive>(async () => ({
          status: "finished",
          receipts: [
            receipt(first, 0, "accepted"),
            receipt(mirror, 1, "accepted"),
            receipt(duplicate, 2, "unchanged"),
          ],
        }));
        const push = makeIsolatedInitiatingGitPush(local, { receiveTrackedPush });
        expect(yield* push(cwd, { ...approval, destinations: [first, mirror, duplicate] })).toEqual(
          {
            status: "pushed",
            branch: "local",
            upstreamBranch: `${remoteName}/tracked`,
            setUpstream: false,
          },
        );
        const parsedFirst = {
          ...first,
          host: "push.invalid",
          user: "git",
          port: 2222,
          repositoryPath: "/group/project.git",
        };
        expect(receiveTrackedPush).toHaveBeenCalledExactlyOnceWith(
          {
            ...approval,
            timeoutMs: 30_000,
            destinations: [
              parsedFirst,
              {
                ...mirror,
                host: "other.invalid",
                user: "git",
                port: 22,
                repositoryPath: "/another.git",
              },
              { ...parsedFirst, expectedOldOid: approval.sourceOid },
            ],
          },
          expect.any(AbortSignal),
        );
        expectOnlyLocalProbes();
      }),
  );

  it.effect("denies absent wiring or approval without running any child", () =>
    Effect.gen(function* () {
      const { cwd, local, approval } = yield* setupProduct();
      const receiveTrackedPush = vi.fn<Receive>();
      expectDenied(
        yield* makeIsolatedInitiatingGitPush(local)(cwd, approval).pipe(Effect.result),
        "without an available owner and approved push scope",
      );
      expectDenied(
        yield* makeIsolatedInitiatingGitPush(local, { receiveTrackedPush })(cwd).pipe(
          Effect.result,
        ),
        "without an available owner and approved push scope",
      );
      expect(local).not.toHaveBeenCalled();
      expect(receiveTrackedPush).not.toHaveBeenCalled();
    }),
  );

  it.effect("refuses stale source, invalid old OID, and an extra configured push destination", () =>
    Effect.gen(function* () {
      const { cwd, local, approval, first, expectOnlyLocalProbes } = yield* setupProduct();
      const receiveTrackedPush = vi.fn<Receive>();
      const push = makeIsolatedInitiatingGitPush(local, { receiveTrackedPush });
      expectDenied(
        yield* push(cwd, { ...approval, sourceOid: old }).pipe(Effect.result),
        "owner denied",
      );
      expectDenied(
        yield* push(cwd, {
          ...approval,
          destinations: [first, { ...mirror, expectedOldOid: "0".repeat(40) }],
        }).pipe(Effect.result),
        "owner denied",
      );
      yield* git(cwd, ["config", "--add", pushUrlKey, "ssh://git@unapproved.invalid/wrong.git"]);
      expectDenied(
        yield* push(cwd, approval).pipe(Effect.result),
        "complete approved effective SSH URL list",
      );
      expect(receiveTrackedPush).not.toHaveBeenCalled();
      expectOnlyLocalProbes();
    }),
  );

  it.effect("never retries partial, mismatched, rejected, or lost owner results", () =>
    Effect.gen(function* () {
      const { cwd, local, approval, first, expectOnlyLocalProbes } = yield* setupProduct();
      const accepted = receipt(first, 0, "accepted");
      const rejected = receipt(mirror, 1, "rejected");
      const check = Effect.fn("checkIsolatedPushReceipt")(function* (
        receive: Receive,
        expected: string,
      ) {
        const receiveTrackedPush = vi.fn(receive);
        const push = makeIsolatedInitiatingGitPush(local, { receiveTrackedPush });
        expectDenied(yield* push(cwd, approval).pipe(Effect.result), expected);
        expect(receiveTrackedPush).toHaveBeenCalledTimes(1);
      });
      yield* check(
        async () => ({ status: "finished", receipts: [accepted, rejected] }),
        "was partial",
      );
      yield* check(async () => ({ status: "finished", receipts: [accepted] }), "was partial");
      yield* check(
        async () => ({ status: "finished", receipts: [rejected, accepted] }),
        "outcome is unknown",
      );
      yield* check(
        async () => ({
          status: "finished",
          receipts: [{ ...accepted, targetGeneration: "stale" }, rejected],
        }),
        "outcome is unknown",
      );
      yield* check(
        async () => ({ status: "finished", receipts: [receipt(first, 0, "rejected"), rejected] }),
        "ref was rejected",
      );
      yield* check(async () => ({ status: "deniedBeforeDispatch" }), "owner denied");
      yield* check(async () => {
        throw new Error("lost owner response");
      }, "outcome is unknown");
      expectOnlyLocalProbes();
    }),
  );

  it.effect("forwards cancellation to the bounded owner without a second dispatch", () =>
    Effect.gen(function* () {
      const { cwd, local, approval, expectOnlyLocalProbes } = yield* setupProduct();
      const started = Promise.withResolvers<AbortSignal>();
      const receiveTrackedPush = vi.fn<Receive>((_request, signal) => {
        started.resolve(signal);
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      const push = makeIsolatedInitiatingGitPush(local, { receiveTrackedPush });
      const fiber = yield* push(cwd, approval).pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(fiber);
      expect(signal.aborted).toBe(true);
      expect(receiveTrackedPush).toHaveBeenCalledTimes(1);
      expectOnlyLocalProbes();
    }),
  );

  it.effect("requires a scoped no-update receipt at every destination for up-to-date", () =>
    Effect.gen(function* () {
      const { cwd, local, approval, first, expectOnlyLocalProbes } = yield* setupProduct();
      const receiveTrackedPush = vi.fn<Receive>(async () => ({
        status: "finished",
        receipts: [receipt(first, 0, "unchanged"), receipt(mirror, 1, "unchanged")],
      }));
      const push = makeIsolatedInitiatingGitPush(local, { receiveTrackedPush });
      expectDenied(yield* push(cwd, approval).pipe(Effect.result), "outcome is unknown");
      const [a, b] = approval.destinations;
      const result = yield* push(cwd, {
        ...approval,
        destinations: [
          { ...a, expectedOldOid: approval.sourceOid },
          { ...b, expectedOldOid: approval.sourceOid },
        ],
      });
      expect(result.status).toBe("skipped_up_to_date");
      expect(receiveTrackedPush).toHaveBeenCalledTimes(2);
      expectOnlyLocalProbes();
    }),
  );

  it.effect("composes the bounded transport into the product owner layer", () =>
    Effect.gen(function* () {
      const { cwd, local, approval, first, expectOnlyLocalProbes } = yield* setupProduct();
      const receiveTrackedPush = vi.fn<Receive>(async () => ({
        status: "finished",
        receipts: [receipt(first, 0, "accepted"), receipt(mirror, 1, "accepted")],
      }));
      const layer = makeIsolatedInitiatingGitOwnerLayer(approval, { receiveTrackedPush });
      const result = yield* pushInitiatingBranch(local, cwd, () =>
        Effect.die("legacy push must not run"),
      ).pipe(Effect.provide(layer));
      expect(result).toMatchObject({ status: "pushed", branch: "local" });
      expect(receiveTrackedPush).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          remoteName,
          sourceOid: approval.sourceOid,
          destinations: [
            expect.objectContaining({ effectiveUrl: effective, expectedOldOid: old }),
            expect.objectContaining({
              effectiveUrl: mirror.effectiveUrl,
              expectedOldOid: mirror.expectedOldOid,
            }),
          ],
        }),
        expect.any(AbortSignal),
      );
      expectOnlyLocalProbes();
    }),
  );
});
