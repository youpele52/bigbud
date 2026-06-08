import path from "node:path";

import { GitCommandError, type GitServiceError } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";

import { type ProcessRunResult, runProcess } from "../../utils/processRunner.ts";
import { ServerConfig } from "../../startup/config.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";
import { GitCoreLive, makeGitCore } from "./GitCore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-core-test-" });

const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);

export const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer);

export function makeTmpDir(
  prefix = "git-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

export function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

/** Run a raw git command for test setup (not under test). */
export function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "GitCore.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

export function configureRemote(
  cwd: string,
  remoteName: string,
  remotePath: string,
  fetchNamespace: string,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    yield* git(cwd, ["config", `remote.${remoteName}.url`, remotePath]);
    return yield* git(cwd, [
      "config",
      "--replace-all",
      `remote.${remoteName}.fetch`,
      `+refs/heads/*:refs/remotes/${fetchNamespace}/*`,
    ]);
  });
}

export function runShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Effect.Effect<ProcessRunResult, Error> {
  return Effect.promise(() => {
    const shellPath =
      process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh");

    const args =
      process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];

    return runProcess(shellPath, args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 30_000,
      allowNonZeroExit: true,
      maxBufferBytes: input.maxOutputBytes ?? 1_000_000,
      outputMode: "truncate",
    });
  });
}

export const makeIsolatedGitCore = (executeOverride: GitCoreShape["execute"]) =>
  makeGitCore({ executeOverride }).pipe(
    Effect.provide(Layer.provideMerge(ServerConfigLayer, NodeServices.layer)),
  );

/** Create a repo with an initial commit so branches work. */
export function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  { initialBranch: string },
  GitServiceError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });
}

export function commitWithDate(
  cwd: string,
  fileName: string,
  fileContents: string,
  dateIsoString: string,
  message: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* writeTextFile(path.join(cwd, fileName), fileContents);
    yield* git(cwd, ["add", fileName]);
    yield* git(cwd, ["commit", "-m", message], {
      ...process.env,
      GIT_AUTHOR_DATE: dateIsoString,
      GIT_COMMITTER_DATE: dateIsoString,
    });
  });
}

export function buildLargeText(lineCount = 20_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

export function splitNullSeparatedPaths(input: string): string[] {
  return input
    .split("\0")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
