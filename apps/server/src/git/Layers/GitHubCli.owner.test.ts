import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";

import { runProcess } from "../../utils/processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";
import { GitHubCliOwnerTransport } from "./GitHubCli.owner.ts";

vi.mock("../../utils/processRunner", () => ({ runProcess: vi.fn() }));

function provideOwner() {
  const execute = vi.fn(
    async (
      _input: { cwd: string; args: ReadonlyArray<string>; timeoutMs: number },
      _signal: AbortSignal,
    ) => ({ stdout: "[]\n", stderr: "", code: 0 }),
  );
  return {
    execute,
    layer: Layer.succeed(GitHubCliOwnerTransport, { execute }),
  };
}

it.effect("routes admitted gh API traffic through the owner without a legacy launch", () => {
  const owner = provideOwner();
  return Effect.gen(function* () {
    const gh = yield* GitHubCli;
    expect(yield* gh.listOpenPullRequests({ cwd: "/repo", headSelector: "feature" })).toEqual([]);
    expect(owner.execute).toHaveBeenCalledExactlyOnceWith(
      {
        cwd: "/repo",
        args: [
          "pr",
          "list",
          "--head",
          "feature",
          "--state",
          "open",
          "--limit",
          "1",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        timeoutMs: 30_000,
      },
      expect.any(AbortSignal),
    );
    // The owner input carries no environment, so no GIT_SSH_COMMAND can select a transport.
    expect(Object.keys(owner.execute.mock.calls[0]![0]).toSorted()).toEqual([
      "args",
      "cwd",
      "timeoutMs",
    ]);
    expect(runProcess).not.toHaveBeenCalled();
  }).pipe(Effect.provide(Layer.merge(GitHubCliLive, owner.layer)));
});

it.effect("refuses unported gh verbs with a typed error", () => {
  const owner = provideOwner();
  return Effect.gen(function* () {
    const gh = yield* GitHubCli;
    for (const operation of [
      gh.execute({ cwd: "/repo", args: ["status"] }),
      gh.execute({ cwd: "/repo", args: ["pr", "merge", "1"] }),
    ]) {
      expect(yield* Effect.flip(operation)).toMatchObject({
        _tag: "GitHubCliError",
        detail: expect.stringContaining("No ambient transport was started"),
      });
    }
    expect(owner.execute).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
  }).pipe(Effect.provide(Layer.merge(GitHubCliLive, owner.layer)));
});
