import { Effect, Path } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { makeGitHelpers } from "./GitCoreExecutor.ts";
import {
  ambientTransportDenied,
  ambientTransportEnvironment,
  InitiatingFetchOwner,
  initiatingTransportUnavailable,
  isInitiatingTransportUnavailable,
  validateFetchOperands,
} from "./GitCore.initiatingTransport.ts";
import { makeGitStatusOps } from "./GitStatus.ts";

const success: ExecuteGitResult = {
  code: 0,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

interface LaunchRecord {
  readonly command: string;
  readonly ancestorPid: number;
  readonly args: ReadonlyArray<string>;
}

function gitFixture(status: string) {
  const launches: LaunchRecord[] = [];
  const execute = (input: ExecuteGitInput): Effect.Effect<ExecuteGitResult> => {
    const args = input.args;
    const result = (() => {
      if (args[0] === "status") return { ...success, stdout: status };
      if (args[0] === "remote" && args[1] === "get-url")
        return { ...success, stdout: "ssh://u@target.example/repo.git\n" };
      if (args[0] === "remote") return { ...success, stdout: "origin\n" };
      if (args.includes("@{upstream}")) return { ...success, stdout: "origin/main\n" };
      if (args.includes("--git-common-dir")) return { ...success, stdout: "/repo/.git\n" };
      if (args[0] === "diff") return success;
      if (args[0] === "symbolic-ref") return { ...success, code: 1 };
      if (args[0] === "rev-parse") return { ...success, code: 1 };
      return success;
    })();
    launches.push({ command: `git ${args.join(" ")}`, ancestorPid: process.pid, args });
    return Effect.succeed(result);
  };
  const helpers = makeGitHelpers(execute);
  const fetch = vi.fn(async (_operands: unknown, _signal: AbortSignal) => "fetched" as const);
  const ownerFetch = (operands: unknown, signal: AbortSignal) => {
    launches.push({ command: "owner://fetch", ancestorPid: process.pid, args: [] });
    return fetch(operands, signal);
  };
  return { launches, fetch, ownerFetch, helpers };
}

function statusOps(fixture: ReturnType<typeof gitFixture>) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* makeGitStatusOps(fixture.helpers, path, "initiating");
  });
}

const cleanStatus = [
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +0 -0",
  "",
].join("\n");

describe("owner-controlled initiating fetch", () => {
  beforeEach(() => {});

  it("sends explicit fetch through the owner with the 30 s bound", async () => {
    const fixture = gitFixture(cleanStatus);
    const result = await Effect.runPromise(
      statusOps(fixture).pipe(
        Effect.flatMap((ops) => ops.fetch("/repo")),
        Effect.provideService(InitiatingFetchOwner, {
          fetch: (operands, signal) => fixture.ownerFetch(operands, signal),
        }),
        Effect.provide(Path.layer),
      ),
    );
    expect(result).toEqual({ status: "fetched" });
    expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(
      { cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 30_000 },
      expect.any(AbortSignal),
    );
    expect(fixture.launches.some(({ args }) => args.includes("fetch"))).toBe(false);
  });

  it("binds background refresh to the owner with the 5 s timeout and 15 s cache", async () => {
    const fixture = gitFixture(cleanStatus);
    await Effect.runPromise(
      statusOps(fixture).pipe(
        Effect.flatMap((ops) =>
          ops.statusDetails("/repo").pipe(Effect.andThen(ops.statusDetails("/repo"))),
        ),
        Effect.provideService(InitiatingFetchOwner, {
          fetch: (operands, signal) => fixture.ownerFetch(operands, signal),
        }),
        Effect.provide(Path.layer),
      ),
    );
    expect(fixture.fetch).toHaveBeenCalledExactlyOnceWith(
      { cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 5_000 },
      expect.any(AbortSignal),
    );
    // Only the owner binding represents transport ancestry; no ambient ssh appears.
    const transports = fixture.launches.filter(
      ({ command }) => command === "owner://fetch" || command.includes("ssh"),
    );
    expect(transports.map(({ command }) => command)).toEqual(["owner://fetch"]);
    expect(transports[0]?.ancestorPid).toBe(process.pid);
  });

  it("refuses an absent owner with a typed error instead of an ambient launch", async () => {
    const fixture = gitFixture(cleanStatus);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const ops = yield* makeGitStatusOps(fixture.helpers, path, "initiating");
        return yield* Effect.flip(ops.fetch("/repo"));
      }).pipe(Effect.provide(Path.layer)),
    );
    expect(isInitiatingTransportUnavailable(error)).toBe(true);
    expect(fixture.launches.some(({ args }) => args.includes("fetch"))).toBe(false);
  });
});

describe("initiating transport validation", () => {
  it("accepts only bounded, unambiguous fetch operands", () => {
    expect(
      validateFetchOperands({ cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 5_000 }),
    ).toEqual({ cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 5_000 });
    for (const input of [
      { cwd: "repo", remoteName: "origin", refspecs: [], timeoutMs: 5_000 },
      { cwd: "/repo", remoteName: "-oProxyCommand", refspecs: [], timeoutMs: 5_000 },
      { cwd: "/repo", remoteName: "origin", refspecs: ["-x"], timeoutMs: 5_000 },
      { cwd: "/repo", remoteName: "origin", refspecs: [], timeoutMs: 0 },
    ]) {
      expect(validateFetchOperands(input)).toBeUndefined();
    }
  });

  it("names every ambient transport variable and refuses them as typed errors", () => {
    expect(
      ambientTransportEnvironment({
        GIT_SSH_COMMAND: "ssh -oProxyCommand=evil",
        GIT_SSH_VARIANT: "plink",
      }),
    ).toEqual(["GIT_SSH_COMMAND", "GIT_SSH_VARIANT"]);
    expect(ambientTransportEnvironment({ PATH: "/usr/bin" })).toEqual([]);
    expect(ambientTransportDenied("/repo", ["GIT_SSH_COMMAND"])).toMatchObject({
      _tag: "GitCommandError",
      detail: expect.stringContaining("GIT_SSH_COMMAND"),
    });
    expect(initiatingTransportUnavailable("pull", "/repo")).toMatchObject({
      _tag: "GitCommandError",
      detail: expect.stringContaining("No ambient transport"),
    });
  });
});
