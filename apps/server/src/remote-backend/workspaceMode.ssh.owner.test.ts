import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeWorkspaceModeGate } from "./workspaceMode.gate.ts";
import {
  encodeWorkspaceModeRecord,
  sha256Hex,
  type WorkspaceModeRecord,
} from "./workspaceMode.record.ts";
import { reserveWorkspaceMode } from "./workspaceMode.reserve.ts";
import {
  type WorkspaceModeSshInspectOutcome,
  type WorkspaceModeSshObservation,
  type WorkspaceModeSshOwner,
} from "./workspaceMode.ssh.owner.ts";
import { makeSshWorkspaceModeStore } from "./workspaceMode.ssh.ts";

const executionTargetId = "ssh:host=fixture&user=workspace&port=2222";
const workspaceRoot = "/alias/project";
const physicalRoot = "/physical/project";
const scope = { executionTargetId, workspaceRoot };
const identity = {
  hostIdentity: `machine-v1:${"a".repeat(64)}`,
  accountUid: 1001,
  realpathSha256: sha256Hex(physicalRoot),
};
const observation = { ...scope, physicalRoot, identity, generation: 0 };
const backendOwner = `backend-v1:${"b".repeat(64)}`;
const first: WorkspaceModeRecord = {
  ...identity,
  generation: 1,
  mode: "laptop-runtime",
  owner: backendOwner,
};
const ready = (current: WorkspaceModeRecord | null = null): WorkspaceModeSshInspectOutcome => ({
  kind: "ready",
  observation: { ...observation, generation: current?.generation ?? 0 },
  currentRecord: current === null ? null : encodeWorkspaceModeRecord(current),
});

function setup(timeoutMs?: number) {
  const inspectWorkspaceMode = vi.fn<WorkspaceModeSshOwner["inspectWorkspaceMode"]>();
  const publishWorkspaceMode = vi.fn<WorkspaceModeSshOwner["publishWorkspaceMode"]>();
  inspectWorkspaceMode.mockResolvedValue(ready());
  publishWorkspaceMode.mockResolvedValue({ kind: "committed" });
  const owner = { inspectWorkspaceMode, publishWorkspaceMode };
  const store = makeSshWorkspaceModeStore(executionTargetId, timeoutMs, { workspaceRoot, owner });
  return { store, owner, ...owner };
}

describe("workspace mode gate with a selected SSH owner", () => {
  const create = (target = executionTargetId, root = workspaceRoot) =>
    ({
      type: "project.create",
      workspaceExecutionTargetId: target,
      workspaceRoot: root,
    }) as OrchestrationCommand;
  const turn = { type: "thread.turn.start", threadId: "t" } as OrchestrationCommand;
  const readModel = {
    projects: [{ id: "p", workspaceRoot, workspaceExecutionTargetId: executionTargetId }],
    threads: [{ id: "t", projectId: "p" }],
  } as unknown as OrchestrationReadModel;
  const makeGate = (sshOwner: WorkspaceModeSshOwner) =>
    makeWorkspaceModeGate({ serverMode: "desktop", owner: backendOwner, sshOwner });

  it("binds project creation to the exact root and refuses a lazy turn after owner loss", async () => {
    const { owner, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    const gate = makeGate(owner);
    await Effect.runPromise(gate.check(create(), readModel));
    expect(inspectWorkspaceMode.mock.calls).toEqual([[scope, expect.any(AbortSignal)]]);
    expect(publishWorkspaceMode.mock.calls).toEqual([
      [{ observation, nextRecord: encodeWorkspaceModeRecord(first) }, expect.any(AbortSignal)],
    ]);

    inspectWorkspaceMode.mockResolvedValue({ kind: "failed", reason: "unavailable" });
    await expect(Effect.runPromise(gate.check(turn, readModel))).rejects.toMatchObject({
      detail: expect.stringContaining("The SSH owner could not complete"),
    });
    expect(inspectWorkspaceMode).toHaveBeenCalledTimes(2);
    expect(publishWorkspaceMode).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "reconciles a lost publish reply without redispatch (committed: %s)",
    async (committed) => {
      const { owner, inspectWorkspaceMode, publishWorkspaceMode } = setup();
      inspectWorkspaceMode
        .mockResolvedValueOnce(ready())
        .mockResolvedValueOnce(ready(committed ? first : null));
      publishWorkspaceMode.mockResolvedValue({ kind: "uncertain" });
      const result = Effect.runPromise(makeGate(owner).check(create(), readModel));
      if (committed) await expect(result).resolves.toBeUndefined();
      else
        await expect(result).rejects.toMatchObject({
          detail: expect.stringContaining("publication could not be confirmed"),
        });
      expect(inspectWorkspaceMode.mock.calls).toEqual([
        [scope, expect.any(AbortSignal)],
        [scope, expect.any(AbortSignal)],
      ]);
      expect(publishWorkspaceMode).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks a conflicting lazy claim without publishing", async () => {
    const { owner, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    inspectWorkspaceMode.mockResolvedValue(ready({ ...first, mode: "remote-runtime" }));
    await expect(Effect.runPromise(makeGate(owner).check(turn, readModel))).rejects.toMatchObject({
      detail: expect.stringContaining("is a remote-runtime workspace"),
    });
    expect(publishWorkspaceMode).not.toHaveBeenCalled();
  });

  it("rejects an invalid root and does not expose the reservation capability for conversion", async () => {
    const { owner, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    const gate = makeGate(owner);
    await expect(
      Effect.runPromise(gate.check(create(executionTargetId, "relative"), readModel)),
    ).rejects.toMatchObject({
      detail: expect.stringContaining("must be absolute paths"),
    });
    expect(gate.resolve(executionTargetId)).toBeUndefined();
    await Effect.runPromise(gate.check(create("local"), readModel));
    expect(inspectWorkspaceMode).not.toHaveBeenCalled();
    expect(publishWorkspaceMode).not.toHaveBeenCalled();
  });
});

describe("selected SSH workspace-mode reservation owner", () => {
  it("publishes only the canonical claim bound to the exact inspected target, root and generation", async () => {
    const { store, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    expect(await reserveWorkspaceMode(store, workspaceRoot, first.mode, first.owner!)).toEqual({
      kind: "reserved",
      record: first,
    });
    expect(inspectWorkspaceMode.mock.calls).toStrictEqual([[scope, expect.any(AbortSignal)]]);
    expect(publishWorkspaceMode.mock.calls).toStrictEqual([
      [{ observation, nextRecord: encodeWorkspaceModeRecord(first) }, expect.any(AbortSignal)],
    ]);
  });

  it("requires the selected root and refuses an unobserved, mismatched or conversion publish", async () => {
    const { store, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    await expect(store.inspect(physicalRoot)).rejects.toThrow("root was not selected");
    await expect(store.publish(first)).rejects.toThrow("requires an inspected");
    expect(inspectWorkspaceMode).not.toHaveBeenCalled();
    await store.inspect(workspaceRoot);
    for (const change of [
      { generation: 2 },
      { accountUid: 1002 },
      { hostIdentity: `machine-v1:${"c".repeat(64)}` },
      { realpathSha256: sha256Hex("/other") },
      { mode: "remote-runtime" },
      { owner: null },
    ] as const) {
      await expect(store.publish({ ...first, ...change })).rejects.toThrow("reservation claim");
    }
    expect(publishWorkspaceMode).not.toHaveBeenCalled();
  });

  it.each<Partial<WorkspaceModeSshObservation>>([
    { executionTargetId: "ssh:another" },
    { workspaceRoot: physicalRoot },
    { physicalRoot: "/wrong" },
    { identity: { ...identity, hostIdentity: "not-a-host-identity" } },
    { identity: { ...identity, accountUid: -1 } },
    { generation: -1 },
  ])("fails closed on mismatched owner observation %o", async (change) => {
    const { store, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    await store.inspect(workspaceRoot);
    inspectWorkspaceMode.mockResolvedValue({
      kind: "ready",
      observation: { ...observation, ...change },
      currentRecord: null,
    });
    await expect(store.inspect(workspaceRoot)).rejects.toThrow(
      "Invalid SSH workspace mode observation",
    );
    await expect(store.publish(first)).rejects.toThrow("requires an inspected");
    expect(publishWorkspaceMode).not.toHaveBeenCalled();
  });

  it.each([
    [2, encodeWorkspaceModeRecord(first)],
    [1, null],
    [1, encodeWorkspaceModeRecord({ ...first, accountUid: 2000 })],
    [1, `${encodeWorkspaceModeRecord(first)}\n`],
  ] as const)(
    "rejects a mismatched or noncanonical generation record (%s, %s)",
    async (generation, currentRecord) => {
      const { store, inspectWorkspaceMode } = setup();
      inspectWorkspaceMode.mockResolvedValue({
        kind: "ready",
        observation: { ...observation, generation },
        currentRecord,
      });
      await expect(store.inspect(workspaceRoot)).rejects.toThrow(/workspace mode record/i);
    },
  );

  it("re-reads after a confirmed CAS conflict and claims the newer unowned generation", async () => {
    const { store, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    inspectWorkspaceMode
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(ready({ ...first, owner: null }));
    publishWorkspaceMode.mockResolvedValueOnce({ kind: "conflict" });
    const next = { ...first, generation: 2 };
    expect(await reserveWorkspaceMode(store, workspaceRoot, first.mode, first.owner!)).toEqual({
      kind: "reserved",
      record: next,
    });
    expect(inspectWorkspaceMode).toHaveBeenCalledTimes(2);
    expect(publishWorkspaceMode).toHaveBeenNthCalledWith(
      2,
      {
        observation: { ...observation, generation: 1 },
        nextRecord: encodeWorkspaceModeRecord(next),
      },
      expect.any(AbortSignal),
    );
  });

  it("uses exactly one read to reconcile a lost publish reply for a matching record", async () => {
    const { store, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    inspectWorkspaceMode.mockResolvedValueOnce(ready()).mockResolvedValueOnce(ready(first));
    publishWorkspaceMode.mockRejectedValueOnce(new Error("connection lost"));
    expect(await reserveWorkspaceMode(store, workspaceRoot, first.mode, first.owner!)).toEqual({
      kind: "reserved",
      record: first,
    });
    expect(inspectWorkspaceMode).toHaveBeenCalledTimes(2);
    expect(publishWorkspaceMode).toHaveBeenCalledTimes(1);
  });

  it.each([
    ready(),
    ready({ ...first, owner: `backend-v1:${"c".repeat(64)}` }),
    { kind: "failed", reason: "unavailable" },
  ] satisfies WorkspaceModeSshInspectOutcome[])(
    "does not republish after inconclusive reconciliation %o",
    async (reconciliation) => {
      const { store, inspectWorkspaceMode, publishWorkspaceMode } = setup();
      inspectWorkspaceMode.mockResolvedValueOnce(ready()).mockResolvedValueOnce(reconciliation);
      publishWorkspaceMode.mockResolvedValueOnce({ kind: "uncertain" });
      await expect(
        reserveWorkspaceMode(store, workspaceRoot, first.mode, first.owner!),
      ).rejects.toThrow("publication could not be confirmed");
      expect(inspectWorkspaceMode).toHaveBeenCalledTimes(2);
      expect(publishWorkspaceMode).toHaveBeenCalledTimes(1);
    },
  );

  it("does not accept a late conflict or reuse its observation after a publish deadline", async () => {
    const { store, publishWorkspaceMode } = setup(10);
    publishWorkspaceMode.mockImplementation(async (_request, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { kind: "conflict" };
    });
    await store.inspect(workspaceRoot);
    await expect(store.publish(first)).rejects.toThrow("publication could not be confirmed");
    await expect(store.publish(first)).rejects.toThrow("requires an inspected");
    expect(publishWorkspaceMode).toHaveBeenCalledTimes(1);
  });

  it("preserves unsupported vs owner refusal, without legacy SSH", async () => {
    const { store, inspectWorkspaceMode, publishWorkspaceMode } = setup();
    inspectWorkspaceMode.mockResolvedValueOnce({ kind: "unsupported", reason: "not-linux" });
    expect(await reserveWorkspaceMode(store, workspaceRoot, first.mode, first.owner!)).toEqual({
      kind: "unsupported",
      reason: "not-linux",
    });
    inspectWorkspaceMode.mockResolvedValueOnce({ kind: "failed", reason: "refused" });
    await expect(
      reserveWorkspaceMode(store, workspaceRoot, first.mode, first.owner!),
    ).rejects.toThrow("SSH owner refused");
    expect(publishWorkspaceMode).not.toHaveBeenCalled();
  });
});
