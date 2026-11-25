import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";

import { activateDevSshOwner } from "../../ssh/sshOwnerDevMode.ts";
import { runProcess } from "../../utils/processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { initiatingGitOwnerUnavailable } from "./GitCore.initiatingFence.ts";
import { GitHubCliLive } from "./GitHubCli.ts";

vi.mock("../../utils/processRunner", () => ({ runProcess: vi.fn() }));

it.effect("refuses gh and its possible descendants before any launch in selected dev mode", () => {
  activateDevSshOwner();
  const cwd = "/repo";
  return Effect.gen(function* () {
    const gh = yield* GitHubCli;
    for (const operation of [
      gh.checkoutPullRequest({ cwd, reference: "1" }),
      gh.createPullRequest({
        cwd,
        baseBranch: "main",
        headSelector: "feature",
        title: "Title",
        bodyFile: "/body",
      }),
      gh.getPullRequest({ cwd, reference: "1" }),
      gh.getRepositoryCloneUrls({ cwd, repository: "example/project" }),
      gh.execute({ cwd, args: ["pr", "list"] }),
    ]) {
      expect(yield* Effect.flip(operation)).toMatchObject({
        _tag: "GitHubCliError",
        detail: initiatingGitOwnerUnavailable,
      });
    }
    expect(runProcess).not.toHaveBeenCalled();
  }).pipe(Effect.provide(GitHubCliLive));
});
