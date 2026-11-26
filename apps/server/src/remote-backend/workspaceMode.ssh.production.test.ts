import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { makeWorkspaceModeGate } from "./workspaceMode.gate.ts";
import { encodeWorkspaceModeRecord, sha256Hex } from "./workspaceMode.record.ts";
import { reserveWorkspaceMode } from "./workspaceMode.reserve.ts";
import type { WorkspaceModeSshOwner } from "./workspaceMode.ssh.owner.ts";
import {
  makeProductionSshWorkspaceModeStore,
  makeProductionWorkspaceModeSshOwner,
} from "./workspaceMode.ssh.production.ts";

const target = "ssh:host=fixture&user=workspace&port=2222";
const backendOwner = `backend-v1:${"b".repeat(64)}`;
const identityFor = (physicalRoot: string) => ({
  hostIdentity: `machine-v1:${"a".repeat(64)}`,
  accountUid: 1001,
  realpathSha256: sha256Hex(physicalRoot),
});

function fakeOwner() {
  const inspectWorkspaceMode = vi.fn<WorkspaceModeSshOwner["inspectWorkspaceMode"]>(
    async (scope) => ({
      kind: "ready",
      observation: {
        ...scope,
        physicalRoot: `/physical${scope.workspaceRoot}`,
        identity: identityFor(`/physical${scope.workspaceRoot}`),
        generation: 0,
        publicationToken: new Uint8Array(32).fill(7),
      },
      currentRecord: null,
    }),
  );
  const publishWorkspaceMode = vi.fn<WorkspaceModeSshOwner["publishWorkspaceMode"]>(async () => ({
    kind: "committed",
  }));
  return { inspectWorkspaceMode, publishWorkspaceMode };
}

describe("W7 production SSH workspace-mode store", () => {
  it("reserves each root through its own inspection and publishes the laptop claim", async () => {
    const owner = fakeOwner();
    const store = makeProductionSshWorkspaceModeStore(target, owner);
    for (const root of ["/srv/a", "/srv/b"]) {
      const outcome = await reserveWorkspaceMode(store, root, "laptop-runtime", backendOwner);
      expect(outcome).toMatchObject({ kind: "reserved", record: { mode: "laptop-runtime" } });
    }
    expect(owner.inspectWorkspaceMode.mock.calls.map(([scope]) => scope)).toEqual([
      { executionTargetId: target, workspaceRoot: "/srv/a" },
      { executionTargetId: target, workspaceRoot: "/srv/b" },
    ]);
    const published = owner.publishWorkspaceMode.mock.calls.map(([request]) => request);
    expect(published.map((request) => request.observation.workspaceRoot)).toEqual([
      "/srv/a",
      "/srv/b",
    ]);
    expect(JSON.parse(published[1]!.nextRecord)).toMatchObject({
      generation: 1,
      owner: backendOwner,
    });
  });

  it("never publishes without the latest inspection and refuses conversion", async () => {
    const owner = fakeOwner();
    const store = makeProductionSshWorkspaceModeStore(target, owner);
    const record = {
      ...identityFor("/physical/srv/a"),
      generation: 1,
      mode: "remote-runtime" as const,
      owner: backendOwner,
    };
    await expect(store.publish(record)).rejects.toThrow("requires an inspected");
    await store.inspect("/srv/a");
    await expect(store.publish(record)).rejects.toThrow("does not match");
    expect(owner.publishWorkspaceMode).not.toHaveBeenCalled();
    expect(encodeWorkspaceModeRecord(record)).toContain("remote-runtime");
  });

  it("reports an unavailable owner without launching anything and lets a lazy turn proceed", async () => {
    const owner = makeProductionWorkspaceModeSshOwner(() => undefined);
    const store = makeProductionSshWorkspaceModeStore(target, owner);
    await expect(store.inspect("/srv/a")).rejects.toThrow("could not complete");
    const gate = makeWorkspaceModeGate({
      serverMode: "desktop",
      owner: backendOwner,
      sshStore: (id) => makeProductionSshWorkspaceModeStore(id, owner),
    });
    const readModel = {
      projects: [{ id: "p", workspaceRoot: "/srv/a", workspaceExecutionTargetId: target }],
      threads: [{ id: "t", projectId: "p" }],
    } as unknown as OrchestrationReadModel;
    const create = {
      type: "project.create",
      workspaceExecutionTargetId: target,
      workspaceRoot: "/srv/a",
    } as OrchestrationCommand;
    await expect(Effect.runPromise(gate.check(create, readModel))).rejects.toThrow(
      "Could not reserve",
    );
    // An existing project's lazy claim only logs when the owner is unreachable.
    const turn = { type: "thread.turn.start", threadId: "t" } as OrchestrationCommand;
    await Effect.runPromise(gate.check(turn, readModel));
  });

  it("routes each call to the live owner's client for the exact target", async () => {
    const bound: string[] = [];
    const inspectProofWorkspaceMode = vi.fn(async () => ({
      state: "refused" as const,
      reason: "notLinux" as const,
    }));
    const live = {
      descriptorFor: async (targetId: string) => ({ targetId, kind: "structured" }),
      handle: {
        target: (descriptor: { targetId: string }) => {
          bound.push(descriptor.targetId);
          return { inspectProofWorkspaceMode };
        },
      },
    } as unknown as SshOwnerProductionRegistration;
    const owner = makeProductionWorkspaceModeSshOwner(() => live);
    const signal = new AbortController().signal;
    await expect(
      owner.inspectWorkspaceMode({ executionTargetId: target, workspaceRoot: "/srv/a" }, signal),
    ).resolves.toEqual({ kind: "unsupported", reason: "not-linux" });
    expect(bound).toEqual([target]);
    expect(inspectProofWorkspaceMode).toHaveBeenCalledWith({
      executionTargetId: target,
      root: "/srv/a",
    });
  });
});
