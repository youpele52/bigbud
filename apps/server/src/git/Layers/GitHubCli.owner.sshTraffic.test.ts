import { PassThrough } from "node:stream";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { activateDevSshOwner } from "../../ssh/sshOwnerDevMode.fixture.ts";
import { runProcess } from "../../utils/processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";
import { GitHubCliOwnerTransport } from "./GitHubCli.owner.ts";
import type { OwnerGitStreamLease, OwnerGitStreamSession } from "./GitCore.selectedStream.ts";
import { makeSelectedGitHubCliOwnerTransport } from "./GitCore.selectedStream.ts";

vi.mock("../../utils/processRunner", () => ({ runProcess: vi.fn() }));

const targetId = "ssh:host=host&user=git&port=2222&transport=direct-ssh";

function lease(): OwnerGitStreamLease {
  return {
    pipes: {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    },
    exit: Promise.resolve({ code: 0, signal: null }),
    close: vi.fn(async () => undefined),
  };
}

type OpenUpload = (
  input: { readonly executionTargetId: string; readonly repositoryPath: string },
  signal: AbortSignal,
) => Promise<OwnerGitStreamLease>;

function session(openGitUpload: OpenUpload): OwnerGitStreamSession {
  return { targetId, withClient: (operation) => operation({ openGitUpload }) };
}

function processResult() {
  return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false };
}

beforeEach(() => {
  delete process.env.GIT_SSH;
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH_VARIANT;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("routes gh pr checkout SSH through the owner shim, never ambient SSH", async () => {
  activateDevSshOwner();
  const pipes = lease();
  const openGitUpload = vi.fn(async () => pipes);
  vi.mocked(runProcess).mockResolvedValue(processResult());
  const transport = makeSelectedGitHubCliOwnerTransport({
    session: session(openGitUpload),
    resolveRemoteUrl: async () => "ssh://git@host:2222/repo.git",
  });
  const result = await transport.execute(
    { cwd: "/repo", args: ["pr", "checkout", "17"], timeoutMs: 30_000 },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ code: 0 });
  expect(openGitUpload).toHaveBeenCalledExactlyOnceWith(
    { executionTargetId: targetId, repositoryPath: "/repo.git" },
    expect.any(AbortSignal),
  );
  const options = vi.mocked(runProcess).mock.calls[0]![2];
  expect(options?.env?.GIT_SSH_COMMAND).toContain("shim.cjs");
  expect(options?.env?.GIT_SSH_VARIANT).toBe("ssh");
  expect(options?.env?.BIGBUD_GIT_STREAM_SOCKET).toContain("bbgs-");
  expect(pipes.close).toHaveBeenCalledTimes(1);
});

it("refuses an ambient GIT_SSH_COMMAND for gh SSH traffic", async () => {
  activateDevSshOwner();
  vi.stubEnv("GIT_SSH_COMMAND", "ssh -oProxyCommand=evil");
  const openGitUpload = vi.fn<OpenUpload>();
  const transport = makeSelectedGitHubCliOwnerTransport({
    session: session(openGitUpload),
    resolveRemoteUrl: async () => "ssh://git@host:2222/repo.git",
  });
  await expect(
    transport.execute(
      { cwd: "/repo", args: ["pr", "checkout", "17"], timeoutMs: 30_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    _tag: "GitCommandError",
    detail: expect.stringContaining("GIT_SSH_COMMAND"),
  });
  expect(openGitUpload).not.toHaveBeenCalled();
  expect(runProcess).not.toHaveBeenCalled();
});

it("runs API-intent gh verbs with an environment that omits ambient transport", async () => {
  activateDevSshOwner();
  vi.stubEnv("GIT_SSH_COMMAND", "ssh -oProxyCommand=evil");
  vi.mocked(runProcess).mockResolvedValue({ ...processResult(), stdout: "[]\n" });
  const transport = makeSelectedGitHubCliOwnerTransport({
    session: session(vi.fn()),
    resolveRemoteUrl: async () => "ssh://git@host:2222/repo.git",
  });
  await transport.execute(
    { cwd: "/repo", args: ["pr", "list", "--json", "number"], timeoutMs: 30_000 },
    new AbortController().signal,
  );
  const options = vi.mocked(runProcess).mock.calls[0]![2];
  expect(options?.env?.GIT_SSH_COMMAND).toBeUndefined();
  expect(options?.env?.GIT_SSH_VARIANT).toBeUndefined();
});

it("admits pr checkout but refuses unported gh verbs through the product service", () => {
  activateDevSshOwner();
  vi.mocked(runProcess).mockResolvedValue(processResult());
  const openGitUpload = vi.fn<OpenUpload>(async () => lease());
  const transport = makeSelectedGitHubCliOwnerTransport({
    session: session(openGitUpload),
    resolveRemoteUrl: async () => "ssh://git@host:2222/repo.git",
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const gh = yield* GitHubCli;
      yield* gh.checkoutPullRequest({ cwd: "/repo", reference: "17" });
      expect(runProcess).toHaveBeenCalledTimes(1);
      const error = yield* Effect.flip(gh.execute({ cwd: "/repo", args: ["pr", "merge", "17"] }));
      expect(error).toMatchObject({ _tag: "GitHubCliError" });
      expect(runProcess).toHaveBeenCalledTimes(1);
    }).pipe(
      Effect.provide(Layer.merge(GitHubCliLive, Layer.succeed(GitHubCliOwnerTransport, transport))),
    ),
  );
});
