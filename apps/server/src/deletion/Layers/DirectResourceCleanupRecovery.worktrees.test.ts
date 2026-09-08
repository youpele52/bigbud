import * as fs from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PurgeResource } from "../../persistence/Services/PurgeJobRepository.ts";
import { captureResourceIdentity, resolvePurgeResource } from "./EntityPurge.resources.ts";
import { recoverDirectCleanupWorktrees } from "./DirectResourceCleanupRecovery.worktrees.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function capturedResource(root: string, relativePath = "target"): Promise<PurgeResource> {
  const config = { worktreesDir: root } as never;
  const resource = {
    kind: "managed-worktree" as const,
    relativePath,
    identity: null,
    quarantineName: `.bigbud-purge-${relativePath.replaceAll("/", "-")}`,
    action: "delete" as const,
  };
  return {
    ...resource,
    identity: await captureResourceIdentity(resolvePurgeResource(config, resource)),
  };
}

function repository(
  candidates: ReadonlyArray<{
    readonly operationId: string;
    readonly resourceId: string;
    readonly resource: PurgeResource;
    readonly attemptCount: number;
  }>,
) {
  return {
    listEligibleWorktrees: () => Effect.succeed(candidates),
    completeWorktree: vi.fn(() => Effect.succeed(true)),
    retryWorktree: vi.fn(() => Effect.succeed(true)),
    blockWorktree: vi.fn(() => Effect.succeed(true)),
  };
}

describe("managed worktree cleanup recovery", () => {
  it("recovers captured work after restart and resumes quarantine", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), ".worktree-recovery-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "target"));
    await fs.writeFile(path.join(root, "target", "file"), "content");
    const resource = await capturedResource(root);
    await fs.rename(path.join(root, "target"), path.join(root, resource.quarantineName as string));
    const repo = repository([
      { operationId: "operation", resourceId: "worktree", resource, attemptCount: 0 },
    ]);

    await Effect.runPromise(
      recoverDirectCleanupWorktrees({
        repository: repo as never,
        config: { worktreesDir: root } as never,
      }),
    );
    await expect(fs.stat(path.join(root, resource.quarantineName as string))).rejects.toThrow();
    expect(repo.completeWorktree).toHaveBeenCalledTimes(1);
  });

  it("treats an already-absent captured resource as complete", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), ".worktree-absent-"));
    roots.push(root);
    const resource = await capturedResource(root);
    const repo = repository([
      { operationId: "operation", resourceId: "absent", resource, attemptCount: 0 },
    ]);
    await Effect.runPromise(
      recoverDirectCleanupWorktrees({
        repository: repo as never,
        config: { worktreesDir: root } as never,
      }),
    );
    expect(repo.completeWorktree).toHaveBeenCalledTimes(1);
  });

  it("blocks a safety failure without blocking a later candidate", async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), ".worktree-isolation-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "appeared"));
    const appeared = {
      kind: "managed-worktree" as const,
      relativePath: "appeared",
      identity: null,
      quarantineName: ".bigbud-purge-appeared",
      action: "delete" as const,
    };
    const absent = await capturedResource(root, "absent");
    const repo = repository([
      { operationId: "operation", resourceId: "appeared", resource: appeared, attemptCount: 0 },
      { operationId: "operation", resourceId: "absent", resource: absent, attemptCount: 0 },
    ]);
    await Effect.runPromise(
      recoverDirectCleanupWorktrees({
        repository: repo as never,
        config: { worktreesDir: root } as never,
      }),
    );
    expect(repo.blockWorktree).toHaveBeenCalledTimes(1);
    expect(repo.completeWorktree).toHaveBeenCalledTimes(1);
    expect(await fs.stat(path.join(root, "appeared"))).toBeDefined();
  });

  it("retries transient failures and blocks at the bounded budget", async () => {
    const missingRoot = path.join(process.cwd(), `.missing-worktree-${crypto.randomUUID()}`);
    const resource = {
      kind: "managed-worktree" as const,
      relativePath: "target",
      identity: {
        declaredPath: path.join(missingRoot, "target"),
        canonicalPath: path.join(missingRoot, "target"),
        device: 1,
        inode: 1,
        changedAtMs: 1,
        type: "directory" as const,
        root: { canonicalPath: missingRoot, device: 1, inode: 1 },
        parent: { canonicalPath: missingRoot, device: 1, inode: 1 },
      },
      quarantineName: ".bigbud-purge-target",
      action: "delete" as const,
    };
    const retrying = repository([
      { operationId: "retry", resourceId: "retry", resource, attemptCount: 0 },
    ]);
    await Effect.runPromise(
      recoverDirectCleanupWorktrees({
        repository: retrying as never,
        config: { worktreesDir: missingRoot } as never,
      }),
    );
    expect(retrying.retryWorktree).toHaveBeenCalledTimes(1);

    const exhausted = repository([
      { operationId: "blocked", resourceId: "blocked", resource, attemptCount: 4 },
    ]);
    await Effect.runPromise(
      recoverDirectCleanupWorktrees({
        repository: exhausted as never,
        config: { worktreesDir: missingRoot } as never,
      }),
    );
    expect(exhausted.blockWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "retry_budget_exhausted" }),
    );
  });
});
