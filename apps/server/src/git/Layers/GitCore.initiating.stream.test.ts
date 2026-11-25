import { PassThrough } from "node:stream";
import { connect } from "node:net";
import { once } from "node:events";
import { expect, it, vi } from "vitest";

import {
  makeSelectedInitiatingFetchBinding,
  openOwnerGitStream,
  type OwnerGitStreamLease,
  type OwnerGitStreamSession,
} from "./GitCore.selectedStream.ts";

const targetId = "ssh:host=host&user=git&port=2222&transport=direct-ssh";

function lease() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    pipes: { stdin, stdout, stderr },
    exit: Promise.resolve({ code: 0, signal: null }),
    close: vi.fn(async () => undefined),
  } satisfies OwnerGitStreamLease;
}

type OpenUpload = (
  input: { readonly executionTargetId: string; readonly repositoryPath: string },
  signal: AbortSignal,
) => Promise<OwnerGitStreamLease>;

function session(openGitUpload: OpenUpload) {
  return {
    targetId,
    withClient: (operation) => operation({ openGitUpload }),
  } satisfies OwnerGitStreamSession;
}

it("bridges the owner lease to the generated shim socket", async () => {
  const pipes = lease();
  const openGitUpload = vi.fn<OpenUpload>(async () => pipes);
  const stream = await openOwnerGitStream(
    session(openGitUpload),
    "/repo.git",
    new AbortController().signal,
  );
  expect(openGitUpload).toHaveBeenCalledExactlyOnceWith(
    { executionTargetId: targetId, repositoryPath: "/repo.git" },
    expect.any(AbortSignal),
  );
  expect(stream.env.GIT_SSH_VARIANT).toBe("ssh");
  expect(stream.env.GIT_SSH_COMMAND).toContain("shim.cjs");

  const socket = connect(stream.env.BIGBUD_GIT_STREAM_SOCKET!);
  const received = once(pipes.pipes.stdin, "data");
  await once(socket, "connect");
  socket.write("hello");
  expect((await received)[0]).toEqual(Buffer.from("hello"));
  const reply = once(socket, "data");
  pipes.pipes.stdout.write("world");
  expect((await reply)[0]).toEqual(Buffer.from("world"));
  socket.destroy();
  await stream.close();
  expect(pipes.close).toHaveBeenCalledTimes(1);
});

it("runs fetch through the owner shim with bounded caps and no ambient ssh", async () => {
  const pipes = lease();
  const openGitUpload = vi.fn<OpenUpload>(async () => pipes);
  const runs: Array<{
    args: readonly string[];
    env: Record<string, string>;
    timeoutMs: number;
  }> = [];
  const binding = makeSelectedInitiatingFetchBinding({
    session: session(openGitUpload),
    resolveRemoteUrl: async () => "ssh://git@host:2222/repo.git",
    runGit: async (args, options) => {
      runs.push({ args, env: options.env, timeoutMs: options.timeoutMs });
      return { code: 0, stderr: "" };
    },
  });
  await expect(
    binding.fetch(
      {
        cwd: "/work",
        remoteName: "origin",
        refspecs: ["+refs/heads/main:refs/remotes/origin/main"],
        timeoutMs: 60_000,
      },
      new AbortController().signal,
    ),
  ).resolves.toBe("fetched");
  expect(openGitUpload).toHaveBeenCalledExactlyOnceWith(
    { executionTargetId: targetId, repositoryPath: "/repo.git" },
    expect.any(AbortSignal),
  );
  expect(runs).toHaveLength(1);
  expect(runs[0]!.args).toEqual([
    "fetch",
    "--no-tags",
    "--quiet",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  expect(runs[0]!.env.GIT_SSH_COMMAND).toContain("shim.cjs");
  expect(runs[0]!.env.GIT_SSH_VARIANT).toBe("ssh");
  // The 60 s caller cap is bounded to the owner's 30 s fetch cap.
  expect(runs[0]!.timeoutMs).toBe(30_000);
  expect(runs[0]!.args.some((arg) => arg === "ssh" || arg.startsWith("-oProxy"))).toBe(false);
  expect(pipes.close).toHaveBeenCalledTimes(1);
});

it("refuses a destination that the selected target does not own", async () => {
  const openGitUpload = vi.fn<OpenUpload>();
  const binding = makeSelectedInitiatingFetchBinding({
    session: session(openGitUpload),
    resolveRemoteUrl: async () => "ssh://git@other.invalid:2222/repo.git",
    runGit: async () => ({ code: 0, stderr: "" }),
  });
  await expect(
    binding.fetch(
      { cwd: "/work", remoteName: "origin", refspecs: [], timeoutMs: 5_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ _tag: "GitCommandError" });
  expect(openGitUpload).not.toHaveBeenCalled();
});

it("surfaces a failed fetch and still closes the lease", async () => {
  const pipes = lease();
  const binding = makeSelectedInitiatingFetchBinding({
    session: session(vi.fn(async () => pipes)),
    resolveRemoteUrl: async () => "ssh://git@host:2222/repo.git",
    runGit: async () => ({ code: 128, stderr: "fatal: nope" }),
  });
  await expect(
    binding.fetch(
      { cwd: "/work", remoteName: "origin", refspecs: [], timeoutMs: 5_000 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ _tag: "GitCommandError", detail: "fatal: nope" });
  expect(pipes.close).toHaveBeenCalledTimes(1);
});
