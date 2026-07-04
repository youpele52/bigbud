import { Effect, Option } from "effect";

import type { GitCoreShape } from "../../git/Services/GitCore.ts";

export function isInsideGitWorkTree(
  gitOption: Option.Option<GitCoreShape>,
  cwd: string,
): Effect.Effect<boolean> {
  return Option.match(gitOption, {
    onSome: (git) => git.isInsideWorkTree(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
    onNone: () => Effect.succeed(false),
  });
}

export function filterGitIgnoredPaths(
  gitOption: Option.Option<GitCoreShape>,
  cwd: string,
  relativePaths: string[],
): Effect.Effect<string[], never> {
  return Option.match(gitOption, {
    onSome: (git) =>
      git.filterIgnoredPaths(cwd, relativePaths).pipe(
        Effect.map((paths) => [...paths]),
        Effect.catch(() => Effect.succeed(relativePaths)),
      ),
    onNone: () => Effect.succeed(relativePaths),
  });
}
