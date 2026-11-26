import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import type { GitUploadState } from "../../ssh/sshOwnerPickerProof.codec.gitUpload.ts";
import { isInitiatingTransportUnavailable } from "./GitCore.initiatingTransport.ts";
import {
  makeProductionInitiatingFetchBinding,
  workspaceRootFor,
} from "./GitCore.selectedStream.production.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Stand-in for the owner's lease: one private socket whose single connection runs
 * `git-upload-pack` on the validated repository, as the owner's pinned child does.
 */
function fakeOwner(root: string) {
  const opened: Array<{ workspaceRoot: string; repositoryPath: string }> = [];
  const servers: Server[] = [];
  const bound = {
    async openGitUpload(lease: Uint8Array, workspaceRoot: string, repositoryPath: string) {
      opened.push({ workspaceRoot, repositoryPath });
      const socketPath = join(root, `s${opened.length}.sock`);
      const server = createServer((socket) => {
        server.close();
        const child = spawn("git-upload-pack", [repositoryPath], { stdio: "pipe" });
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
        child.on("exit", () => socket.end());
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      return { lease, phase: "listening", socketPath } satisfies GitUploadState;
    },
    gitUploadStatus: async (lease: Uint8Array) =>
      ({ lease, phase: "exited", exitCode: 0 }) satisfies GitUploadState,
    closeGitUpload: async (lease: Uint8Array) =>
      ({ lease, phase: "closed" }) satisfies GitUploadState,
  };
  const registration = {
    handle: { target: () => bound },
    descriptorFor: async () => ({
      targetId: "ssh:host=vm.example&user=dev",
      kind: "structured",
      host: "vm.example",
      port: 22,
      user: "dev",
      authMode: "key",
      identityFile: "/k",
      knownHostsFile: "/h",
    }),
  } as unknown as SshOwnerProductionRegistration;
  return { registration, opened, servers };
}

describe("U15 production owner Git binding", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bbprod-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function prepare() {
    const workspace = join(root, "ws");
    const bare = join(workspace, "repo.git");
    const other = join(root, "other");
    const work = join(root, "work");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(root, "clone", "-q", bare, other);
    for (const file of ["a", "b"]) {
      writeFileSync(join(other, file), file);
      git(other, "add", file);
      git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
      git(other, "push", "-q", "origin", "HEAD:main");
      if (file === "a") git(root, "clone", "-q", bare, work);
    }
    git(work, "remote", "set-url", "origin", `ssh://dev@vm.example${bare}`);
    return { workspace, bare, other, work };
  }

  it("fetches through the owner lease for a repository inside the target's workspace root", async () => {
    const { workspace, bare, other, work } = prepare();
    const owner = fakeOwner(root);
    const binding = makeProductionInitiatingFetchBinding({
      owner: () => owner.registration,
      records: async () => [
        { executionTargetId: "ssh:host=vm.example&user=dev", workspaceRoot: workspace },
      ],
    });
    await expect(
      binding.fetch(
        { cwd: work, remoteName: "origin", refspecs: [], timeoutMs: 20_000 },
        new AbortController().signal,
      ),
    ).resolves.toBe("fetched");
    expect(owner.opened).toEqual([{ workspaceRoot: workspace, repositoryPath: bare }]);
    expect(git(work, "rev-parse", "origin/main")).toBe(git(other, "rev-parse", "HEAD"));
  });

  it("refuses typed when the repository is outside every workspace root", async () => {
    const { work } = prepare();
    const owner = fakeOwner(root);
    const binding = makeProductionInitiatingFetchBinding({
      owner: () => owner.registration,
      records: async () => [
        {
          executionTargetId: "ssh:host=vm.example&user=dev",
          workspaceRoot: join(root, "elsewhere"),
        },
      ],
    });
    const error = await binding
      .fetch(
        { cwd: work, remoteName: "origin", refspecs: [], timeoutMs: 20_000 },
        new AbortController().signal,
      )
      .catch((cause: unknown) => cause);
    expect(isInitiatingTransportUnavailable(error)).toBe(true);
    expect(owner.opened).toEqual([]);
  });

  it("refuses when no owner is live or the remote's user differs", async () => {
    const { workspace, work } = prepare();
    const records = vi.fn(async () => [
      { executionTargetId: "ssh:host=vm.example&user=dev", workspaceRoot: workspace },
    ]);
    const none = makeProductionInitiatingFetchBinding({ owner: () => undefined, records });
    const operands = { cwd: work, remoteName: "origin", refspecs: [], timeoutMs: 5_000 };
    expect(
      isInitiatingTransportUnavailable(
        await none.fetch(operands, new AbortController().signal).catch((cause: unknown) => cause),
      ),
    ).toBe(true);
    git(work, "remote", "set-url", "origin", `ssh://other@vm.example${workspace}/repo.git`);
    const owner = fakeOwner(root);
    const mismatch = makeProductionInitiatingFetchBinding({
      owner: () => owner.registration,
      records,
    });
    expect(
      isInitiatingTransportUnavailable(
        await mismatch
          .fetch(operands, new AbortController().signal)
          .catch((cause: unknown) => cause),
      ),
    ).toBe(true);
    expect(owner.opened).toEqual([]);
  });

  it("picks the longest admitting root", () => {
    expect(workspaceRootFor(["/srv", "/srv/ws", null, "/srv/wsx"], "/srv/ws/r.git")).toBe(
      "/srv/ws",
    );
    expect(workspaceRootFor(["/srv/other"], "/srv/ws/r.git")).toBeUndefined();
  });
});
