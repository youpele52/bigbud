import { describe, expect, it, vi } from "vitest";

import {
  makeOwnedDeploymentSshRunner,
  type OwnedDeploymentRemoteRunner,
} from "../remote-backend/deployment.ssh.owner.ts";
import type {
  DeploymentStepOutcome,
  DeploymentStepRequest,
} from "../remote-backend/deployment.ssh.owner.operations.ts";
import {
  decodeWorkspaceModeRecord,
  encodeWorkspaceModeRecord,
  sha256Hex,
  workspaceModeOwnerId,
  type WorkspaceModeStore,
} from "../remote-backend/workspaceMode.record.ts";
import {
  makeOwnedSshWorkspaceModeStore,
  type WorkspaceModeSshObservation,
  type WorkspaceModeSshOwner,
} from "../remote-backend/workspaceMode.ssh.owner.ts";

const target = "ssh:host=vps&user=deploy&port=2202&auth=ssh-key";
const otherTarget = "ssh:host=other&user=deploy&port=2202&auth=ssh-key";
const workspaceRoot = "/home/deploy/workspace";
const physicalRoot = "/srv/deploy/workspace";
const hostIdentity = `machine-v1:${"a".repeat(64)}`;
const ownerId = workspaceModeOwnerId(hostIdentity, "/home/deploy/.bigbud/backend");
const identity = { hostIdentity, accountUid: 1000, realpathSha256: sha256Hex(physicalRoot) };

/** One canonical reservation directory, with the store's CAS semantics. */
function reservation(initial: Map<number, string> = new Map()) {
  const records = new Map(initial);
  const observations: WorkspaceModeSshOwner = {
    async inspectWorkspaceMode(scope) {
      if (scope.executionTargetId !== target || scope.workspaceRoot !== workspaceRoot)
        return { kind: "failed", reason: "refused" };
      const latest = Math.max(0, ...records.keys());
      return {
        kind: "ready",
        observation: {
          ...scope,
          physicalRoot,
          identity,
          generation: latest,
          publicationToken: Uint8Array.of(1, 2, 3),
        } satisfies WorkspaceModeSshObservation,
        currentRecord: latest === 0 ? null : records.get(latest)!,
      };
    },
    async publishWorkspaceMode({ observation, nextRecord }) {
      const next = decodeWorkspaceModeRecord(nextRecord);
      if (next.generation !== observation.generation + 1)
        return { kind: "failed", reason: "refused" };
      if (records.has(next.generation)) return { kind: "conflict" };
      records.set(next.generation, nextRecord);
      return { kind: "committed" };
    },
  };
  return { records, owner: observations };
}

describe("native workspace-mode store", () => {
  it("reads the reservation, publishes one generation and re-reads it", async () => {
    const state = reservation();
    const store = makeOwnedSshWorkspaceModeStore(target, 5_000, {
      owner: state.owner,
      workspaceRoot,
    });
    await expect(store.inspect(workspaceRoot)).resolves.toMatchObject({
      kind: "ready",
      identity,
      current: null,
    });
    await expect(
      store.publish({ ...identity, generation: 1, mode: "laptop-runtime", owner: ownerId }),
    ).resolves.toBe("committed");
    expect(state.records.get(1)).toBe(
      encodeWorkspaceModeRecord({
        ...identity,
        generation: 1,
        mode: "laptop-runtime",
        owner: ownerId,
      }),
    );

    const reread = await store.inspect(workspaceRoot);
    expect(reread).toMatchObject({ kind: "ready", current: { generation: 1, owner: ownerId } });
  });

  it("refuses to publish without a fresh inspection or for the wrong root", async () => {
    const state = reservation();
    const store = makeOwnedSshWorkspaceModeStore(target, 5_000, {
      owner: state.owner,
      workspaceRoot,
    });
    await expect(
      store.publish({ ...identity, generation: 1, mode: "laptop-runtime", owner: ownerId }),
    ).rejects.toThrow("inspected reservation claim");
    await expect(store.inspect("/home/deploy/other")).rejects.toThrow("not selected");
  });

  it("refuses a wrong-target selection before any owner dispatch", () => {
    const state = reservation();
    expect(() =>
      makeOwnedSshWorkspaceModeStore("local", 5_000, {
        owner: state.owner,
        workspaceRoot,
      }),
    ).toThrow("Invalid SSH workspace mode target");
    const store = makeOwnedSshWorkspaceModeStore(otherTarget, 5_000, {
      owner: {
        inspectWorkspaceMode: vi.fn(async () => ({
          kind: "failed" as const,
          reason: "refused" as const,
        })),
        publishWorkspaceMode: vi.fn(),
      },
      workspaceRoot,
    });
    return expect(store.inspect(workspaceRoot)).rejects.toThrow("refused");
  });

  it("keeps an unsupported host typed rather than reporting it unavailable", async () => {
    const store = makeOwnedSshWorkspaceModeStore(target, 5_000, {
      owner: {
        inspectWorkspaceMode: async () => ({ kind: "unsupported", reason: "not-linux" }),
        publishWorkspaceMode: async () => ({ kind: "failed", reason: "refused" }),
      },
      workspaceRoot,
    });
    await expect(store.inspect(workspaceRoot)).resolves.toStrictEqual({
      kind: "unsupported",
      reason: "not-linux",
    });
  });

  it("never reports a lost publication as a conflict", async () => {
    const state = reservation();
    const store: WorkspaceModeStore = makeOwnedSshWorkspaceModeStore(target, 5_000, {
      owner: {
        inspectWorkspaceMode: state.owner.inspectWorkspaceMode,
        publishWorkspaceMode: async () => {
          throw new Error("transport lost");
        },
      },
      workspaceRoot,
    });
    await store.inspect(workspaceRoot);
    await expect(
      store.publish({ ...identity, generation: 1, mode: "laptop-runtime", owner: ownerId }),
    ).rejects.toThrow("could not be confirmed");
  });
});

describe("deployment stage sequence on the selected target", () => {
  const requestId = "3baaeec7-e811-40a3-bf2b-09608f12f1ec";
  const installName = `1.2.3-aarch64-unknown-linux-gnu-${"b".repeat(16)}`;

  function stagedRunner() {
    const calls: DeploymentStepRequest[] = [];
    const deploymentStep = vi.fn(
      async (request: DeploymentStepRequest): Promise<DeploymentStepOutcome> => {
        calls.push(request);
        return {
          requestId: request.requestId,
          action: request.action,
          exitCode: 0,
          stdout: "",
          stderr: "",
          state: "completed",
          outcomeUnknown: false,
          reattached: false,
        };
      },
    );
    return {
      calls,
      runner: makeOwnedDeploymentSshRunner({
        deploymentAction: vi.fn(),
        deploymentStep,
      }) as OwnedDeploymentRemoteRunner & {
        runDeploymentStep: NonNullable<OwnedDeploymentRemoteRunner["runDeploymentStep"]>;
      },
    };
  }

  it("runs reset, upload, publish and start in order for the selected target", async () => {
    const { calls, runner } = stagedRunner();
    const base = {
      executionTargetId: target,
      requestId,
      installName,
      archiveSha256: "c".repeat(64),
      manifestSha256: "d".repeat(64),
      nodePath: "bin/node",
      entryPath: "app/entry.mjs",
    } as const;
    await runner.runDeploymentStep({ ...base, action: "reset" }, new AbortController().signal);
    await runner.runDeploymentStep(
      {
        ...base,
        action: "archiveUpload",
        contents: Uint8Array.of(1, 2, 3),
      },
      new AbortController().signal,
    );
    await runner.runDeploymentStep(
      { ...base, action: "publish", pins: [{ path: "bin/node", sha256: "e".repeat(64) }] },
      new AbortController().signal,
    );
    await runner.runDeploymentStep(
      { ...base, action: "start", authorityId: "f".repeat(32), enableBoot: false },
      new AbortController().signal,
    );
    expect(calls.map((call) => call.action)).toStrictEqual([
      "reset",
      "archiveUpload",
      "publish",
      "start",
    ]);
  });

  it("refuses the same sequence for another execution target", async () => {
    const { calls, runner } = stagedRunner();
    await expect(
      runner.runDeploymentStep(
        {
          executionTargetId: workspaceRoot,
          action: "reset",
          requestId,
          installName,
          archiveSha256: "c".repeat(64),
          manifestSha256: "d".repeat(64),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-target" });
    expect(calls).toHaveLength(0);
  });
});
