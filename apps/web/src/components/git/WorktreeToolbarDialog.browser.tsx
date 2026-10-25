import "../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { WorktreeToolbarDialog } from "./WorktreeToolbarDialog";

it("requires an explicit confirmation before submitting deletion", async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  await render(
    <WorktreeToolbarDialog
      target={{ kind: "delete" }}
      baseBranch="main"
      onClose={close}
      onSubmit={submit}
    />,
  );
  await expect
    .element(
      page.getByText("Only an unreferenced, clean linked worktree can be removed.", {
        exact: false,
      }),
    )
    .toBeVisible();
  expect(submit).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Delete worktree", exact: true }).click();
  await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(close).toHaveBeenCalledOnce();
});

it("cancel never submits a physical operation", async () => {
  const submit = vi.fn();
  const close = vi.fn();
  await render(
    <WorktreeToolbarDialog
      target={{ kind: "delete" }}
      baseBranch="main"
      onClose={close}
      onSubmit={submit}
    />,
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(close).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
});
