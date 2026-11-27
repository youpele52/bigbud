import { execFile } from "node:child_process";
import path from "node:path";

import { GitCommandError } from "@bigbud/contracts";
import { Effect, FileSystem, PlatformError, Scope } from "effect";

import { GitCore } from "../Services/GitCore.ts";

export function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const scope = yield* Scope.Scope;
    const tempDir = yield* fileSystem.makeTempDirectory({ prefix });
    yield* Scope.addFinalizer(
      scope,
      fileSystem.remove(tempDir, { recursive: true }).pipe(Effect.catch(() => Effect.void)),
    );
    return tempDir;
  });
}

/**
 * Runs fixture-setup git directly. Fixture arrangement (pushes to local bare remotes, fetches)
 * is not product traffic, so it does not go through GitCore and its initiating transport fence.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  { readonly code: number; readonly stdout: string; readonly stderr: string },
  GitCommandError
> {
  return Effect.callback<
    { readonly code: number; readonly stdout: string; readonly stderr: string },
    GitCommandError
  >((resume) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      if (code !== 0 && !allowNonZeroExit) {
        resume(
          Effect.fail(
            new GitCommandError({
              operation: "GitManager.test.runGit",
              command: `git ${args.join(" ")}`,
              cwd,
              detail: stderr.trim() || error?.message || `git exited with code ${code}`,
            }),
          ),
        );
        return;
      }
      resume(Effect.succeed({ code, stdout, stderr }));
    });
  });
}

export function initRepo(
  cwd: string,
): Effect.Effect<
  void,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

export function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("bigbud-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

export function configureRemote(
  cwd: string,
  remoteName: string,
  remotePath: string,
  fetchNamespace: string,
): Effect.Effect<void, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, remotePath]);
    yield* runGit(cwd, [
      "config",
      "--replace-all",
      `remote.${remoteName}.fetch`,
      `+refs/heads/*:refs/remotes/${fetchNamespace}/*`,
    ]);
  });
}

function toFileUrlLocalBarePath(localBarePath: string): string {
  const normalized = localBarePath.endsWith("/") ? localBarePath : `${localBarePath}/`;
  return `file://${normalized}`;
}

/** Point a GitHub-style remote URL at a local bare repo for fetch/push without network I/O. */
export function configureGitHubRemoteMirror(
  cwd: string,
  remoteName: string,
  localBarePath: string,
  githubUrl: string,
): Effect.Effect<void, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const insteadOfTarget = toFileUrlLocalBarePath(localBarePath);
    yield* runGit(cwd, ["config", `url.${insteadOfTarget}.insteadOf`, githubUrl]);
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, githubUrl]);
    yield* runGit(cwd, ["config", `remote.${remoteName}.pushurl`, localBarePath]);
  });
}
