import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import {
  defaultFetchRouteDependencies,
  ordinaryGitTransport,
  type FetchRouteDependencies,
} from "./GitCore.fetchRoute.ts";
import type { RemoteRoute } from "./GitCore.fetchRoute.match.ts";

/**
 * Ordinary selected-mode push (U7, U14): HTTP(S)/file/local-path remotes, or SSH hosts that are
 * not bigbud targets, under the same fence as fetch. Tags and submodule pushes are never
 * implied; the caller passes the exact refspec.
 *
 * @module GitCore.pushRoute
 */

const PUSH_TIMEOUT_MS = 120_000;

export interface OrdinaryPushInput {
  readonly cwd: string;
  readonly kind: Exclude<RemoteRoute["kind"], "unsupported">;
  /** `[-u] <remote> <refspec>`, chosen by the caller. */
  readonly args: ReadonlyArray<string>;
}

export async function runOrdinarySelectedPush(
  input: OrdinaryPushInput,
  signal: AbortSignal,
  dependencies: Partial<Pick<FetchRouteDependencies, "readGitConfig" | "runGit">> = {},
): Promise<"pushed"> {
  const deps = { ...defaultFetchRouteDependencies, ...dependencies };
  const { configArgs, env } = await ordinaryGitTransport(input.kind, input.cwd, deps);
  const result = await deps.runGit(
    [...configArgs, "push", "--no-follow-tags", "--recurse-submodules=no", ...input.args],
    { cwd: input.cwd, env, timeoutMs: PUSH_TIMEOUT_MS, signal },
  );
  if (result.code !== 0) {
    throw new GitCommandError({
      operation: "GitCore.pushCurrentBranch",
      command: "git push",
      cwd: input.cwd,
      detail: result.stderr.trim() || "Git push failed.",
    });
  }
  return "pushed";
}
