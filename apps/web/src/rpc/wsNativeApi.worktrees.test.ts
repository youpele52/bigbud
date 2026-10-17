import { expect, it } from "vitest";
import type { WorktreeOperationSummary } from "@bigbud/contracts/workspace/worktrees.ts";
import { rpcClientMock } from "./wsNativeApi.test.helpers";

it("forwards durable operation discovery and reconciliation without inventing another operation ID", async () => {
  const operation: WorktreeOperationSummary = {
    operationId: "original-durable-id",
    kind: "rename",
    source: "/trees/old",
    destination: "/trees/new",
    phase: "recovery-required",
    error: "Unconfirmed",
    canRecheck: true,
  };
  rpcClientMock.worktrees.operations.mockResolvedValueOnce([operation]);
  rpcClientMock.worktrees.recover.mockResolvedValueOnce({
    ...operation,
    phase: "completed",
    error: null,
    canRecheck: false,
  });
  const { createWsNativeApi } = await import("./wsNativeApi");
  const api = createWsNativeApi();
  const context = { cwd: "/repo", executionTargetId: "local" };
  await expect(api.worktrees!.operations(context)).resolves.toEqual([operation]);
  await expect(
    api.worktrees!.recover({ ...context, operationId: operation.operationId }),
  ).resolves.toMatchObject({ phase: "completed" });
  expect(rpcClientMock.worktrees.operations).toHaveBeenCalledWith(context);
  expect(rpcClientMock.worktrees.recover).toHaveBeenCalledWith({
    ...context,
    operationId: operation.operationId,
  });
});
