import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";

import {
  clearSshTargetDisconnected,
  markSshTargetDisconnected,
} from "../../ssh/sshTargetDisconnects.ts";
import { GitCore } from "../Services/GitCore.ts";
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

const pushUrlKey = `remote.${remoteName}.pushurl`;
const siblingUrl = "ssh://writer@mirror.invalid/group/mirror.git";
const mirrorScope = {
  effectiveUrl: siblingUrl,
  executionTargetId: "ssh:host=mirror.invalid&user=writer",
  targetGeneration: "mirror-generation",
};

const setupDestinations = Effect.fn("setupInitiatingPushDestinations")(function* () {
  const fixture = yield* setup();
  const { cwd, approvedPush: single } = fixture;
  yield* git(cwd, ["config", "--add", pushUrlKey, "fixture-mirror:group/mirror.git"]);
  yield* git(cwd, ["config", "url.ssh://writer@mirror.invalid/.insteadOf", "fixture-mirror:"]);
  const firstScope = {
    effectiveUrl: effective,
    executionTargetId: single.executionTargetId,
    targetGeneration: single.targetGeneration,
  };
  const { direction, repository, refs } = single;
  const approvedPush = {
    direction,
    repository,
    remoteName,
    refs,
    destinations: [firstScope, mirrorScope],
  } as const satisfies ApprovedInitiatingGitPush;
  return { ...fixture, approvedPush };
});

it.layer(TestLayer)("initiating Git push destination list", (it) => {
  it.effect(
    "dispatches a complete ordered list of rewritten URLs, retaining repeated entries",
    () =>
      Effect.gen(function* () {
        const { cwd, core, approvedPush, sourceOid, local, remote } = yield* setupDestinations();
        const [first, mirror] = approvedPush.destinations;
        yield* git(cwd, ["config", "--add", pushUrlKey, effective]);
        const push = vi.fn(async (_request: InitiatingGitPushRequest) => "pushed" as const);
        const result = yield* core.pushCurrentBranch(cwd, null).pipe(
          Effect.provideService(InitiatingGitOwner, {
            approvedPush: { ...approvedPush, destinations: [first, mirror, first] },
            owner: { push },
          }),
        );
        const firstDestination = {
          ...first,
          host: "push.invalid",
          user: "git",
          port: 2222,
          repositoryPath: "/group/project.git",
        };
        expect(result.status).toBe("pushed");
        expect(push).toHaveBeenCalledExactlyOnceWith(
          {
            ...approvedPush,
            sourceOid,
            destinations: [
              firstDestination,
              {
                ...mirror,
                host: "mirror.invalid",
                user: "writer",
                port: 22,
                repositoryPath: "/group/mirror.git",
              },
              firstDestination,
            ],
          },
          expect.any(AbortSignal),
        );
        expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
        expect(remote).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "denies reordered, incomplete, extra, non-SSH, or differently spelled destinations",
    () =>
      Effect.gen(function* () {
        const { cwd, core, approvedPush, local, remote } = yield* setupDestinations();
        const [first, mirror] = approvedPush.destinations;
        const push = vi.fn(async () => "pushed" as const);
        const selected = (approval: ApprovedInitiatingGitPush) =>
          core.pushCurrentBranch(cwd, null).pipe(
            Effect.provideService(InitiatingGitOwner, {
              approvedPush: approval,
              owner: { push },
            }),
            Effect.result,
          );
        const listMismatch = "complete approved effective SSH URL list";
        expectDenied(
          yield* selected({ ...approvedPush, destinations: [mirror, first] }),
          listMismatch,
        );
        expectDenied(yield* selected({ ...approvedPush, destinations: [first] }), listMismatch);
        expectDenied(
          yield* selected({ ...approvedPush, destinations: [first, mirror, mirror] }),
          listMismatch,
        );
        expectDenied(
          yield* selected({
            ...approvedPush,
            destinations: [first, { ...mirror, targetGeneration: "" }],
          }),
          "invalid or disconnected",
        );
        expectDenied(
          yield* selected({
            ...approvedPush,
            destinations: [first, { ...mirror, executionTargetId: first.executionTargetId }],
          }),
          "invalid or disconnected",
        );
        for (const url of [
          siblingUrl.replace(".invalid/", ".invalid:22/"),
          "https://mirror.invalid/group/mirror.git",
          "writer@mirror.invalid:group/mirror.git",
        ]) {
          yield* git(cwd, ["config", "--replace-all", pushUrlKey, effective]);
          yield* git(cwd, ["config", "--add", pushUrlKey, url]);
          expectDenied(yield* selected(approvedPush), listMismatch);
          if (!url.startsWith("ssh://")) {
            expectDenied(
              yield* selected({
                ...approvedPush,
                destinations: [first, { ...mirror, effectiveUrl: url }],
              }),
              "invalid or disconnected",
            );
          }
        }
        expect(push).not.toHaveBeenCalled();
        expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
        expect(remote).not.toHaveBeenCalled();
      }),
  );

  it.effect("uses Git's pushInsteadOf destination list when there are no explicit push URLs", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush } = yield* setupDestinations();
      const urlKey = `remote.${remoteName}.url`;
      yield* git(cwd, ["config", "--unset-all", pushUrlKey]);
      yield* git(cwd, [
        "config",
        "--replace-all",
        urlKey,
        "https://read.invalid/group/project.git",
      ]);
      yield* git(cwd, ["config", "--add", urlKey, "https://read-mirror.invalid/group/mirror.git"]);
      yield* git(cwd, [
        "config",
        "url.ssh://git@push.invalid:2222/.pushInsteadOf",
        "https://read.invalid/",
      ]);
      yield* git(cwd, [
        "config",
        "url.ssh://writer@mirror.invalid/.pushInsteadOf",
        "https://read-mirror.invalid/",
      ]);
      const push = vi.fn(async (_request: InitiatingGitPushRequest) => "upToDate" as const);
      const result = yield* core
        .pushCurrentBranch(cwd, null)
        .pipe(Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }));
      expect(result.status).toBe("skipped_up_to_date");
      expect(push).toHaveBeenCalledTimes(1);
      expect(push.mock.calls[0]?.[0].destinations.map(({ effectiveUrl }) => effectiveUrl)).toEqual([
        effective,
        siblingUrl,
      ]);
    }),
  );

  it.effect("does not confuse a multiline URL with multiple Git output records", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush } = yield* setupDestinations();
      yield* git(cwd, ["config", "--replace-all", pushUrlKey, `${effective}\n${siblingUrl}`]);
      expect(yield* git(cwd, ["remote", "get-url", "--push", "--all", remoteName])).toBe(
        `${effective}\n${siblingUrl}`,
      );
      const push = vi.fn(async () => "pushed" as const);
      expectDenied(
        yield* core
          .pushCurrentBranch(cwd, null)
          .pipe(
            Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }),
            Effect.result,
          ),
        "unambiguously inspect",
      );
      expect(push).not.toHaveBeenCalled();
    }),
  );

  it.effect("revalidates effective push URLs before dispatch when a sibling rewrite changes", () =>
    Effect.gen(function* () {
      const { cwd, core, local, remote, approvedPush } = yield* setupDestinations();
      const actual = yield* GitCore;
      const guardedProbe = local.getMockImplementation()!;
      let reads = 0;
      local.mockImplementation((input) =>
        guardedProbe(input).pipe(
          Effect.tap(() => {
            if (input.args[1] !== "remote" || ++reads !== 1) return Effect.void;
            return git(cwd, [
              "config",
              "--rename-section",
              "url.ssh://writer@mirror.invalid/",
              "url.ssh://writer@mirror.invalid/drift/",
            ]).pipe(Effect.provideService(GitCore, actual), Effect.asVoid);
          }),
        ),
      );
      const push = vi.fn(async () => "pushed" as const);
      expectDenied(
        yield* core
          .pushCurrentBranch(cwd, null)
          .pipe(
            Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }),
            Effect.result,
          ),
        "complete approved effective SSH URL list",
      );
      expect(reads).toBe(2);
      expect(push).not.toHaveBeenCalled();
      expect(remote).not.toHaveBeenCalled();
    }),
  );

  it.effect("denies the complete push if a sibling disconnects after URL revalidation", () =>
    Effect.gen(function* () {
      const { cwd, core, local, remote, approvedPush } = yield* setupDestinations();
      const guardedProbe = local.getMockImplementation()!;
      const targetId = mirrorScope.executionTargetId;
      let reads = 0;
      let marked = false;
      yield* Effect.addFinalizer(() =>
        marked ? Effect.promise(() => clearSshTargetDisconnected(targetId)) : Effect.void,
      );
      local.mockImplementation((input) =>
        guardedProbe(input).pipe(
          Effect.tap(() => {
            if (input.args[1] !== "remote" || ++reads !== 2) return Effect.void;
            return Effect.promise(async () => {
              marked = await markSshTargetDisconnected(targetId);
            });
          }),
        ),
      );
      const push = vi.fn(async () => "pushed" as const);
      expectDenied(
        yield* core
          .pushCurrentBranch(cwd, null)
          .pipe(
            Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }),
            Effect.result,
          ),
        "invalid or disconnected",
      );
      expect(reads).toBe(2);
      expect(push).not.toHaveBeenCalled();
      expect(remote).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps partial, unknown and rejected whole-list outcomes distinct without retry", () =>
    Effect.gen(function* () {
      const { cwd, core, approvedPush, local, remote } = yield* setupDestinations();
      for (const [outcome, message] of [
        ["partial", "was partial. Verify the remote state"],
        ["unknown", "outcome is unknown. Verify the remote state"],
        ["rejectedRef", "ref was rejected"],
      ] as const) {
        const push = vi.fn(async () => outcome);
        expectDenied(
          yield* core
            .pushCurrentBranch(cwd, null)
            .pipe(
              Effect.provideService(InitiatingGitOwner, { approvedPush, owner: { push } }),
              Effect.result,
            ),
          message,
        );
        expect(push).toHaveBeenCalledTimes(1);
      }
      expect(local.mock.calls.every(([input]) => isLocalProbe(input))).toBe(true);
      expect(remote).not.toHaveBeenCalled();
    }),
  );
});
