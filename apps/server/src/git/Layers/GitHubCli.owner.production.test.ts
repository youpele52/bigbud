import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import type { SshTargetEndpoint } from "./GitCore.fetchRoute.match.ts";
import { bridgeOwnerGitLease } from "./GitCore.selectedStream.ts";
import {
  makeProductionGitHubCliOwnerTransport,
  uploadPackCommand,
  type ProductionGitHubCliDependencies,
} from "./GitHubCli.owner.production.ts";

const checkout = { cwd: "/repo", args: ["pr", "checkout", "64", "--force"], timeoutMs: 30_000 };
const target: SshTargetEndpoint = { hosts: ["devbox"], user: "me", port: 22 };

function transport(
  urls: ReadonlyArray<string>,
  overrides: Partial<ProductionGitHubCliDependencies> = {},
) {
  const runGh = vi.fn<NonNullable<ProductionGitHubCliDependencies["runGh"]>>(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
  }));
  const owner = vi.fn(() => undefined as SshOwnerProductionRegistration | undefined);
  const value = makeProductionGitHubCliOwnerTransport({
    owner,
    records: async () => [],
    targets: async () => [target],
    listRemoteUrls: async () => urls,
    readGitConfig: async () => undefined,
    resolveEndpoint: async (spec) => ({
      hosts: [spec.host],
      ...(spec.user ? { user: spec.user } : {}),
    }),
    runGh,
    ...overrides,
  });
  return { value, runGh, owner };
}

const signal = new AbortController().signal;

describe("production gh transport (U7)", () => {
  it("runs API verbs locally with a sanitized environment", async () => {
    const { value, runGh } = transport([]);
    await value.execute({ cwd: "/repo", args: ["pr", "view", "1"], timeoutMs: 1_000 }, signal);
    const env = runGh.mock.calls[0]![1].env;
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ALLOW_PROTOCOL).toBeUndefined();
  });

  it("checks out over HTTPS remotes under the local protocol fence", async () => {
    const { value, runGh, owner } = transport(["https://github.com/base/project.git"]);
    await value.execute(checkout, signal);
    expect(runGh.mock.calls[0]![1].env.GIT_ALLOW_PROTOCOL).toBe("http:https:file");
    expect(owner).not.toHaveBeenCalled();
  });

  it("uses the U14 fence for third-party SSH hosts", async () => {
    const { value, runGh, owner } = transport(["git@github.com:base/project.git"]);
    await value.execute(checkout, signal);
    const env = runGh.mock.calls[0]![1].env;
    expect(env.GIT_ALLOW_PROTOCOL).toBe("http:https:file:ssh");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("core.sshCommand");
    expect(env.GIT_CONFIG_VALUE_0).toBe("ssh -o BatchMode=yes");
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(owner).not.toHaveBeenCalled();
  });

  it("refuses typed before gh when a target remote has no live owner", async () => {
    const { value, runGh } = transport(["ssh://me@devbox/srv/repo.git"]);
    await expect(value.execute(checkout, signal)).rejects.toMatchObject({
      operation: "GitCore.initiating.checkoutPullRequest",
    });
    expect(runGh).not.toHaveBeenCalled();
  });

  it("refuses an unknown target set, unsupported remotes and mixed SSH routes", async () => {
    for (const [urls, overrides] of [
      [["git@github.com:base/project.git"], { targets: async () => undefined }],
      [["ext::sh -c evil"], {}],
      [["ssh://me@devbox/srv/repo.git", "git@github.com:base/project.git"], {}],
    ] as const) {
      const { value, runGh } = transport(urls, overrides);
      await expect(value.execute(checkout, signal)).rejects.toMatchObject({
        operation: "GitCore.initiating.checkoutPullRequest",
      });
      expect(runGh).not.toHaveBeenCalled();
    }
  });

  it("pins the shim to Git's exact upload-pack command", () => {
    expect(uploadPackCommand("/srv/repo.git")).toBe("git-upload-pack '/srv/repo.git'");
    expect(uploadPackCommand("/srv/it's.git")).toBeUndefined();
    expect(uploadPackCommand("/srv/wow!.git")).toBeUndefined();
  });

  it("the shim refuses any SSH command other than the pinned upload-pack", async () => {
    const close = vi.fn(async () => undefined);
    const stream = await bridgeOwnerGitLease(
      {
        pipes: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
        exit: new Promise(() => undefined),
        close,
      },
      signal,
    );
    try {
      const [node, shim] = stream.env.GIT_SSH_COMMAND!.split(" ").map((part) => part.slice(1, -1));
      const result = spawnSync(
        node!,
        [shim!, "git@github.com", "git-upload-pack 'base/project.git'"],
        {
          env: { ...stream.env, BIGBUD_GIT_STREAM_EXPECT: "git-upload-pack '/srv/repo.git'" },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not served by the owner Git stream");
    } finally {
      await stream.close();
    }
    expect(close).toHaveBeenCalled();
  });
});
