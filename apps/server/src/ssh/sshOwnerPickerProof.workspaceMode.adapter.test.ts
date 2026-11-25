import { expect, it, vi } from "vitest";
import { workspaceModeForPickerProof } from "./sshOwnerPickerProof.workspaceMode.ts";

const scope = { executionTargetId: "ssh:fixture", workspaceRoot: "/fixture" };
const identity = {
  hostIdentity: `machine-v1:${"a".repeat(64)}`,
  accountUid: 1000,
  realpathSha256: "b".repeat(64),
};
const publicationToken = new Uint8Array(32).fill(0x51);
const physicalRoot = "/fixture";
const observation = { ...scope, physicalRoot, generation: 0, identity, publicationToken };
const publish = { observation, nextRecord: "fixture" };

it("limits both native calls to the selected root and execution target", async () => {
  const inspectProofWorkspaceMode = vi.fn(async () => ({
    state: "ready" as const,
    physicalRoot,
    generation: 0,
    publicationToken,
    ...identity,
  }));
  const publishProofWorkspaceMode = vi.fn(async () => ({ kind: "committed" as const }));
  const owner = workspaceModeForPickerProof(scope, {
    inspectProofWorkspaceMode,
    publishProofWorkspaceMode,
  });
  const { signal } = new AbortController();
  await expect(
    owner.inspectWorkspaceMode({ ...scope, executionTargetId: "ssh:other" }, signal),
  ).resolves.toEqual({ kind: "failed", reason: "refused" });
  await expect(
    owner.publishWorkspaceMode(
      { ...publish, observation: { ...observation, workspaceRoot: "/other" } },
      signal,
    ),
  ).resolves.toEqual({ kind: "failed", reason: "refused" });
  expect(inspectProofWorkspaceMode).not.toHaveBeenCalled();
  expect(publishProofWorkspaceMode).not.toHaveBeenCalled();
  await expect(owner.inspectWorkspaceMode(scope, signal)).resolves.toEqual({
    kind: "ready",
    observation,
    currentRecord: null,
  });
  await expect(owner.publishWorkspaceMode(publish, signal)).resolves.toEqual({ kind: "committed" });
});

it("does not dispatch a pre-aborted write or retry an uncertain publication", async () => {
  const controller = new AbortController();
  const publishProofWorkspaceMode = vi.fn(async () => {
    controller.abort();
    return { kind: "committed" as const };
  });
  const owner = workspaceModeForPickerProof(scope, {
    inspectProofWorkspaceMode: async () => ({ state: "refused", reason: "notLinux" }),
    publishProofWorkspaceMode,
  });
  await expect(owner.publishWorkspaceMode(publish, AbortSignal.abort())).resolves.toEqual({
    kind: "failed",
    reason: "unavailable",
  });
  expect(publishProofWorkspaceMode).not.toHaveBeenCalled();
  await expect(owner.publishWorkspaceMode(publish, controller.signal)).resolves.toEqual({
    kind: "uncertain",
  });
  expect(publishProofWorkspaceMode).toHaveBeenCalledTimes(1);
});
