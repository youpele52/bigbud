import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { Effect, Path } from "effect";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { ServerConfig } from "../startup/config.ts";
import type { BootstrapWorktreeIdentity } from "./wsBootstrap.ts";

export const makeBootstrapWorktreeIdentityResolver = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;

  return (input: {
    readonly parentCommandId: string;
    readonly projectCwd: string;
    readonly branch: string;
    readonly executionTargetId?: string;
  }): BootstrapWorktreeIdentity | null => {
    if (input.executionTargetId && !isLocalExecutionTarget(input.executionTargetId)) return null;
    const identity = createHash("sha256")
      .update(`${input.parentCommandId}\0${input.projectCwd}\0${input.branch}`)
      .digest("hex");
    return {
      path: path.join(
        config.worktreesDir,
        path.basename(input.projectCwd),
        `bootstrap-${identity}`,
      ),
      canonicalizePath: (candidate) =>
        Effect.tryPromise(() => realpath(candidate)).pipe(Effect.catch(() => Effect.succeed(null))),
    };
  };
});
