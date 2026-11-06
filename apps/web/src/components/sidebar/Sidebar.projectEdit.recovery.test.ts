import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandId, ProjectId } from "@bigbud/contracts";
import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import {
  readProjectEditRecovery,
  retainProjectEdit,
  retryProjectEdit,
} from "./Sidebar.projectEdit.recovery";

const state = vi.hoisted(() => ({
  values: new Map<string, string>(),
  outcome: vi.fn(),
  dispatch: vi.fn(),
  claim: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../stores/ledger/revisionedLedger", () => ({
  resolveLedgerStorage: () => ({
    getItem: (key: string) => state.values.get(key) ?? null,
    setItem: (key: string, value: string) => state.values.set(key, value),
    removeItem: (key: string) => state.values.delete(key),
  }),
}));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ orchestration: { getCommandOutcome: state.outcome } }),
}));
vi.mock("../../lib/orchestrationCommandRecovery.state", () => ({
  claimPendingCommand: state.claim,
  savePendingCommand: state.save,
}));
vi.mock("../../lib/orchestrationCommandRecovery", async (original) => ({
  ...(await original<typeof import("../../lib/orchestrationCommandRecovery")>()),
  dispatchClaimedCommand: state.dispatch,
}));
const projectId = ProjectId.makeUnsafe("retained-project");
const command: ClientOrchestrationCommand = {
  type: "project.reconfigure",
  commandId: CommandId.makeUnsafe("original-request"),
  projectId,
  title: "Keep provider choices",
  workspaceRoot: "/destination",
  expectedUpdatedAt: "2026-11-05T12:00:00.000Z",
  executionTargetId: "local",
  workspaceExecutionTargetId: "local",
  providerRuntimeExecutionTargetId: "local",
  verifiedWorktreePaths: [],
  workspaceAction: "transfer",
  nativeContextReset: "archive-and-reset-muse",
};
beforeEach(() => {
  vi.clearAllMocks();
  state.values.clear();
  state.claim.mockResolvedValue(true);
  state.save.mockResolvedValue(undefined);
  state.dispatch.mockResolvedValue({ sequence: 12 });
});
describe("durable exact project edit recovery", () => {
  it("survives close/reload and redispatches the original JSON without provider/model defaults", async () => {
    retainProjectEdit(projectId, { command, error: "response lost" });
    const originalJson = JSON.stringify(command);
    expect(JSON.stringify(readProjectEditRecovery(projectId)?.command)).toBe(originalJson);
    state.outcome.mockResolvedValue({
      status: "unknown",
      workspaceTransition: { phase: "native-verified" },
    });
    await retryProjectEdit(projectId);
    expect(JSON.stringify(state.dispatch.mock.calls[0]?.[1])).toBe(originalJson);
    expect(state.dispatch.mock.calls[0]?.[1]).not.toHaveProperty("modelSelection");
    expect(readProjectEditRecovery(projectId)).toBeNull();
  });
  it("observes a lost success response without redispatching", async () => {
    retainProjectEdit(projectId, { command, error: "timeout" });
    state.outcome.mockResolvedValue({ status: "accepted", resultSequence: 12 });
    await retryProjectEdit(projectId);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(readProjectEditRecovery(projectId)).toBeNull();
  });
  it("unlocks new consent only after definitive rejection and preserves its explanation", async () => {
    retainProjectEdit(projectId, { command, error: null });
    state.outcome.mockResolvedValue({
      status: "rejected",
      reason: "other",
      detail: "Explicit Muse native-context reset confirmation is required.",
    });
    await expect(retryProjectEdit(projectId)).rejects.toThrow("Explicit Muse");
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(readProjectEditRecovery(projectId)).toBeNull();
  });
  it("keeps the exact request and diagnostic for an uncertain native transition", async () => {
    retainProjectEdit(projectId, { command, error: null });
    state.outcome.mockResolvedValue({
      status: "unknown",
      workspaceTransition: { phase: "recovery-required" },
    });
    state.dispatch.mockRejectedValue(
      new Error("Native ownership remains uncertain; no move was resent."),
    );
    await expect(retryProjectEdit(projectId)).rejects.toThrow("no move was resent");
    expect(readProjectEditRecovery(projectId)).toEqual({
      command,
      error: "Native ownership remains uncertain; no move was resent.",
    });
  });
  it("does not redispatch while the original request is in progress", async () => {
    retainProjectEdit(projectId, { command, error: null });
    state.outcome.mockResolvedValue({ status: "unknown" });
    state.claim.mockResolvedValue(false);
    await expect(retryProjectEdit(projectId)).rejects.toThrow("still being dispatched");
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(readProjectEditRecovery(projectId)?.command).toEqual(command);
  });
  it("never forgets a corrupt retained request", () => {
    state.values.set(`bigbud:project-edit-recovery:v1:${projectId}`, "corrupt");
    expect(() => readProjectEditRecovery(projectId)).toThrow();
    expect(state.values.size).toBe(1);
  });
});
