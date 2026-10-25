import "../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { WorktreeOperationSummary } from "@bigbud/contracts/workspace/worktrees.ts";
import { WorktreeOperationsDialog } from "./WorktreeOperationsDialog";

const operation: WorktreeOperationSummary = {
  operationId: "durable-operation-after-reload",
  kind: "delete",
  source: "/trees/old",
  destination: "/trees/new",
  phase: "recovery-required",
  error: "Acknowledgement was lost. Workspace remains reserved.",
  canRecheck: true,
};

it("shows durable identity and rechecks an operation after a fresh mount", async () => {
  const recheck = vi.fn().mockResolvedValue(undefined);
  const screen = await render(
    <WorktreeOperationsDialog
      operations={[operation]}
      error={null}
      onClose={vi.fn()}
      onRecheck={recheck}
    />,
  );
  await expect.element(screen.getByText("Operation: durable-operation-after-reload")).toBeVisible();
  await expect.element(screen.getByText("/trees/old → /trees/new")).toBeVisible();
  await screen.getByRole("button", { name: "Recheck operation" }).click();
  expect(recheck).toHaveBeenCalledExactlyOnceWith(operation.operationId);
});

it("explains unconfirmed activity without offering an unsafe release", async () => {
  const screen = await render(
    <WorktreeOperationsDialog
      operations={[{ ...operation, kind: "access", canRecheck: false }]}
      error={null}
      onClose={vi.fn()}
      onRecheck={vi.fn()}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Recheck operation" }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText("Activity exit is unconfirmed.", { exact: false }))
    .toBeVisible();
});
