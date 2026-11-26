import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Path } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import { activateDevSshOwner } from "../../ssh/sshOwnerDevMode.fixture.ts";
import type {
  GitReceiveApproval,
  GitReceiveState,
} from "../../ssh/sshOwnerPickerProof.codec.gitReceive.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import type { ExecuteGitInput } from "../Services/GitCore.ts";
import { makeGitHelpers } from "./GitCoreExecutor.ts";
import { InitiatingFetchOwner } from "./GitCore.initiatingTransport.ts";
import {
  makeProductionPushBinding,
  pushRejectionReason,
  receiptOf,
} from "./GitCore.selectedStream.receive.ts";
import { makeGitStatusOps } from "./GitStatus.ts";

const TARGET = "ssh:host=vm.example&user=dev";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function commit(cwd: string, name: string): string {
  writeFileSync(join(cwd, name), name);
  git(cwd, "add", name);
  git(cwd, "commit", "-qm", name);
  return git(cwd, "rev-parse", "HEAD");
}

/** Real local Git as the workspace executor. */
const execute = (input: ExecuteGitInput) =>
  Effect.sync(() => {
    try {
      const stdout = execFileSync("git", [...input.args], { cwd: input.cwd, encoding: "utf8" });
      return { code: 0, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string };
      return {
        code: failed.status ?? 1,
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }
  });

/**
 * Stand-in for the owner's receive lease: settles `stale` without touching the repository when
 * the live ref is not the expected old OID, otherwise runs receive-pack on the one connection
 * and reports `accepted` only if the ref then equals the approved source OID.
 */
function fakeOwner(root: string) {
  const approvals: GitReceiveApproval[] = [];
  const servers: Server[] = [];
  let state: GitReceiveState["phase"] | "stale" | "accepted" | "refused" = "listening";
  const bound = {
    async openGitReceive(lease: Uint8Array, approval: GitReceiveApproval) {
      approvals.push(approval);
      const socketPath = join(root, `r${approvals.length}.sock`);
      const head = (ref: string) => {
        try {
          return git(approval.repositoryPath, "rev-parse", "--verify", "--quiet", ref);
        } catch {
          return "0".repeat(approval.sourceOid.length);
        }
      };
      const live = head(approval.destinationRef);
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        server.close();
        if (live !== approval.expectedOldOid) {
          state = "stale";
          socket.destroy();
          return;
        }
        state = "streaming";
        const child = spawn("git-receive-pack", [approval.repositoryPath], { stdio: "pipe" });
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
        child.on("exit", () => {
          socket.end();
          const after = head(approval.destinationRef);
          // Nothing written (local Git refused and sent only a flush): the owner's `refused`.
          state =
            after === approval.sourceOid
              ? "accepted"
              : after === approval.expectedOldOid
                ? "refused"
                : "lost";
        });
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      return { lease, phase: "listening", socketPath } satisfies GitReceiveState;
    },
    gitReceiveStatus: async (lease: Uint8Array): Promise<GitReceiveState> =>
      state === "stale" || state === "accepted" || state === "refused"
        ? { lease, phase: "finished", receipt: state }
        : state === "listening"
          ? { lease, phase: "streaming" }
          : ({ lease, phase: state } as GitReceiveState),
    closeGitReceive: async (lease: Uint8Array) => ({ lease, phase: "closed" }) as GitReceiveState,
  };
  const registration = {
    handle: { target: () => bound, ownerEpoch: new Uint8Array(32).fill(7) },
    descriptorFor: async () => ({
      targetId: TARGET,
      kind: "structured",
      host: "vm.example",
      port: 22,
      user: "dev",
      authMode: "key",
      identityFile: "/k",
      knownHostsFile: "/h",
    }),
  } as unknown as SshOwnerProductionRegistration;
  return { registration, approvals, servers };
}

describe("U15 production push through the owner receive lease", () => {
  let root: string;
  beforeEach(() => {
    activateDevSshOwner();
    root = mkdtempSync(join(tmpdir(), "bbrecv-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function prepare() {
    const workspace = join(root, "ws");
    const bare = join(workspace, "repo.git");
    const work = join(root, "work");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(root, "clone", "-q", bare, work);
    const old = commit(work, "a");
    git(work, "push", "-q", "origin", "main");
    // scp-style remote on the target; the owner, not ambient SSH, carries the push.
    git(work, "remote", "set-url", "origin", `dev@vm.example:${bare}`);
    const owner = fakeOwner(root);
    const binding = {
      fetch: async () => "fetched" as const,
      push: makeProductionPushBinding({
        owner: () => owner.registration,
        records: async () => [{ executionTargetId: TARGET, workspaceRoot: workspace }],
        resolveEndpoint: async (spec) => ({ hosts: [spec.host], ...spec }),
      }),
    };
    const projects = {
      listAll: () => Effect.succeed([{ executionTargetId: TARGET, deletedAt: null }]),
    } as unknown as ProjectionProjectRepositoryShape;
    const push = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const ops = yield* makeGitStatusOps(
            makeGitHelpers(execute),
            yield* Path.Path,
            "initiating",
          );
          return yield* ops.pushCurrentBranch(work, null);
        }).pipe(
          Effect.provideService(InitiatingFetchOwner, binding),
          Effect.provideService(ProjectionProjectRepository, projects),
          Effect.provide(Path.layer),
        ),
      );
    return { bare, work, old, owner, push };
  }

  it("pushes exactly the approved fast-forward of the tracked branch", async () => {
    const { bare, work, old, owner, push } = prepare();
    const next = commit(work, "b");
    await expect(push()).resolves.toMatchObject({ status: "pushed", branch: "main" });
    expect(git(bare, "rev-parse", "main")).toBe(next);
    expect(owner.approvals).toEqual([
      expect.objectContaining({
        repositoryPath: bare,
        destinationRef: "refs/heads/main",
        expectedOldOid: old,
        sourceOid: next,
      }),
    ]);
    for (const server of owner.servers) server.close();
  });

  it("refuses typed when the remote moved since the last fetch, writing nothing", async () => {
    const { bare, work, owner, push } = prepare();
    const other = join(root, "other");
    git(root, "clone", "-q", bare, other);
    const moved = commit(other, "c");
    git(other, "push", "-q", "origin", "main");
    commit(work, "b");
    await expect(push()).rejects.toThrow(/remote branch changed since it was last fetched/u);
    expect(git(bare, "rev-parse", "main")).toBe(moved);
    for (const server of owner.servers) server.close();
  });

  it("surfaces Git's non-fast-forward reason for a diverged branch", async () => {
    const { bare, work, push } = prepare();
    const other = join(root, "other");
    git(root, "clone", "-q", bare, other);
    const moved = commit(other, "c");
    git(other, "push", "-q", "origin", "main");
    commit(work, "b");
    // The user fetched: the tracking ref is current, so the push is not stale but diverged.
    git(work, "fetch", "-q", bare, "+main:refs/remotes/origin/main");
    await expect(push()).rejects.toThrow(
      /rejected: the remote branch has commits you do not have/u,
    );
    expect(git(bare, "rev-parse", "main")).toBe(moved);
  });

  it("publishes a new branch on the target and records its upstream", async () => {
    const { bare, work, owner, push } = prepare();
    git(work, "checkout", "-q", "-b", "feature");
    const next = commit(work, "f");
    await expect(push()).resolves.toMatchObject({
      status: "pushed",
      branch: "feature",
      upstreamBranch: "origin/feature",
      setUpstream: true,
    });
    expect(git(bare, "rev-parse", "feature")).toBe(next);
    expect(git(work, "rev-parse", "--abbrev-ref", "feature@{upstream}")).toBe("origin/feature");
    expect(owner.approvals.at(-1)).toMatchObject({
      destinationRef: "refs/heads/feature",
      expectedOldOid: "0".repeat(40),
      sourceOid: next,
    });
    for (const server of owner.servers) server.close();
  });

  it("extracts a bounded, URL-free rejection reason", () => {
    expect(
      pushRejectionReason(
        "To dev@vm.example:/srv/r.git\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to 'dev@vm.example:/srv/r.git'\n",
      ),
    ).toBe("! [remote rejected] main -> main (pre-receive hook declined)");
    expect(pushRejectionReason(" ! [rejected]        main -> main (fetch first)\n")).toMatch(
      /non-fast-forward\)\. Pull, then push again/u,
    );
    expect(pushRejectionReason("fatal: unrelated\n")).toBeUndefined();
  });

  it("maps settled owner states to receipts", () => {
    const lease = new Uint8Array(32);
    expect(receiptOf({ lease, phase: "finished", receipt: "refused" })).toBe("rejected");
    expect(receiptOf({ lease, phase: "finished", receipt: "stale" })).toBe("stale");
    expect(receiptOf({ lease, phase: "lost" })).toBeUndefined();
    expect(receiptOf({ lease, phase: "unconfirmed" })).toBe("unconfirmed");
    expect(receiptOf("timedOut")).toBe("unconfirmed");
  });
});
