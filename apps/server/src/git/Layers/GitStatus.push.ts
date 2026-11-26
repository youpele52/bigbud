import { Effect, Option, Schema } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { GitCoreShape, GitPushResult } from "../Services/GitCore.ts";
import type { GitHelpers } from "./GitCoreExecutor.ts";
import { createGitCommandError } from "./GitCoreUtils.ts";
import { readSshTargets } from "./GitCore.fetchRoute.hosts.ts";
import {
  classifyRemoteUrl,
  endpointMatchesTarget,
  isSshRoute,
} from "./GitCore.fetchRoute.match.ts";
import { routeEndpoint } from "./GitCore.fetchRoute.ts";
import { produceInitiatingPushApproval } from "./GitCore.initiatingPush.approval.ts";
import { makeIsolatedInitiatingGitPush } from "./GitCore.initiatingPush.composition.ts";
import {
  InitiatingFetchOwner,
  initiatingTransportUnavailable,
} from "./GitCore.initiatingTransport.ts";
import { runOrdinarySelectedPush } from "./GitCore.pushRoute.ts";

interface CurrentUpstream {
  readonly remoteName: string;
  readonly upstreamRef: string;
  readonly upstreamBranch: string;
}

export interface SelectedPushDependencies {
  readonly statusDetailsLocal: GitCoreShape["statusDetailsLocal"];
  readonly resolveCurrentUpstream: (
    cwd: string,
  ) => Effect.Effect<CurrentUpstream | null, GitCommandError>;
  readonly resolvePushRemoteName: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly helpers: Pick<GitHelpers, "execute" | "runGitStdout">;
}

/**
 * Selected-mode push (U7, U14, U15). Push URLs are routed like fetch URLs:
 *
 * - HTTP(S)/file/local path, or SSH to a host that is not a bigbud target: ordinary local
 *   `git push` with legacy semantics (`-u` to publish), fenced as for fetch.
 * - SSH to a bigbud target, or an unreadable target set: the owner receive lease, admitted
 *   by the trusted approval producer and the `pushSelectedInitiatingBranch` guard. A tracked
 *   branch's fast-forward, or the first publish of a branch absent on the target, is admitted.
 * - Anything else, or a mix of routes across several push URLs: refused.
 */
export function makeSelectedPushThroughRoute(deps: SelectedPushDependencies) {
  const { statusDetailsLocal, resolveCurrentUpstream, resolvePushRemoteName, helpers } = deps;
  return Effect.fn("pushThroughSelectedRoute")(function* (
    cwd: string,
    fallbackBranch: string | null,
  ): Effect.fn.Return<GitPushResult, GitCommandError> {
    const fail = (detail: string) =>
      createGitCommandError("GitCore.pushCurrentBranch", cwd, ["push"], detail);
    const details = yield* statusDetailsLocal(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) return yield* fail("Cannot push from detached HEAD.");
    if (details.hasUpstream && details.aheadCount === 0 && details.behindCount === 0) {
      return {
        status: "skipped_up_to_date",
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      };
    }
    const upstream = details.hasUpstream ? yield* resolveCurrentUpstream(cwd) : null;
    const remoteName = upstream?.remoteName ?? (yield* resolvePushRemoteName(cwd, branch));
    if (!remoteName) {
      return yield* fail("Cannot push because no git remote is configured for this repository.");
    }
    const urls = (yield* helpers.runGitStdout("GitCore.pushCurrentBranch.urls", cwd, [
      "remote",
      "get-url",
      "--push",
      "--all",
      "--",
      remoteName,
    ]))
      .split(/\r?\n/u)
      .filter((line) => line.length > 0);
    const routes = urls.map(classifyRemoteUrl);
    const targets = yield* readSshTargets();
    const owned = yield* Effect.promise(() =>
      Promise.all(
        routes.map(async (route) => {
          if (!isSshRoute(route)) return false;
          const endpoint = await routeEndpoint(route);
          return (
            !targets ||
            !endpoint ||
            targets.some((target) => endpointMatchesTarget(endpoint, target))
          );
        }),
      ),
    );
    const kinds = new Set(routes.map((route, index) => (owned[index] ? "owner" : route.kind)));
    const [kind] = kinds;
    if (kinds.size !== 1 || kind === undefined || kind === "unsupported") {
      return yield* initiatingTransportUnavailable("push", cwd);
    }
    if (kind !== "owner") {
      const target = upstream
        ? { args: [remoteName, `HEAD:${upstream.upstreamBranch}`], setUpstream: false }
        : { args: ["-u", remoteName, `HEAD:refs/heads/${branch}`], setUpstream: true };
      yield* Effect.tryPromise({
        try: (signal) => runOrdinarySelectedPush({ cwd, kind, args: target.args }, signal),
        catch: (cause) => (Schema.is(GitCommandError)(cause) ? cause : fail("Git push failed.")),
      });
      return {
        status: "pushed",
        branch,
        upstreamBranch: upstream?.upstreamRef ?? `${remoteName}/${branch}`,
        setUpstream: target.setUpstream,
      };
    }
    if (urls.length !== 1 || !urls[0]) {
      return yield* fail("Pushing to several URLs on a bigbud SSH target is not supported.");
    }
    const binding = Option.getOrUndefined(yield* Effect.serviceOption(InitiatingFetchOwner));
    const push = binding?.push;
    if (!push) return yield* initiatingTransportUnavailable("push", cwd);
    const url = urls[0];
    const target = yield* Effect.promise(() => push.select(url).catch(() => undefined));
    if (!target) return yield* initiatingTransportUnavailable("push", cwd);
    // No upstream: a first publish of this branch under its own name (U15).
    const approval = yield* produceInitiatingPushApproval(helpers.runGitStdout, {
      cwd,
      remoteName,
      upstreamBranch: upstream?.upstreamBranch ?? branch,
      url,
      target,
      publish: upstream === null,
    });
    return yield* makeIsolatedInitiatingGitPush(helpers.execute, push.transport)(cwd, approval);
  });
}
