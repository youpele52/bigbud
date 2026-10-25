import "../../index.css";
import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { WorktreeInventory } from "@bigbud/contracts/workspace/worktrees.ts";
import { WorktreeToolbarPicker } from "./WorktreeToolbarPicker";
import { BranchToolbarLayout } from "./BranchToolbar.layout";

const inventory: WorktreeInventory = {
  repository: "/repo/.git",
  checkoutPath: "/repo",
  linkedCount: 1,
  local: true,
  entries: [
    {
      path: "/repo",
      name: "repo",
      branch: "main",
      head: "abc",
      identity: "1:1",
      main: true,
      bare: false,
      locked: null,
      prunable: null,
    },
    {
      path: "/trees/physical-folder",
      name: "physical-folder",
      branch: "different-branch",
      head: "def",
      identity: "1:2",
      main: false,
      bare: false,
      locked: null,
      prunable: null,
    },
  ],
};
const props = () => ({
  inventory,
  selectedPath: "/repo",
  disabled: false,
  onRefresh: vi.fn(),
  onCreate: vi.fn(),
  onSelect: vi.fn(),
  onDelete: vi.fn(),
});

describe("worktree picker", () => {
  it("does not flash a middle control before a main-only inventory is known", async () => {
    const screen = await render(<WorktreeToolbarPicker {...props()} inventory={undefined} />);
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  });
  it("permits independent creation while switching and lifecycle mutations are locked", async () => {
    const create = vi.fn();
    const screen = await render(<WorktreeToolbarPicker {...props()} disabled onCreate={create} />);
    await screen.getByRole("button", { name: "Worktree: Main checkout" }).click();
    await page.getByRole("menuitem", { name: "Create worktree…" }).click();
    expect(create).toHaveBeenCalledOnce();
  });
  it("hides with no linked worktrees", async () => {
    const screen = await render(
      <WorktreeToolbarPicker
        {...props()}
        inventory={{ ...inventory, linkedCount: 0, entries: inventory.entries.slice(0, 1) }}
      />,
    );
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  });
  it("shows Main checkout rather than its branch when linked worktrees exist", async () => {
    const screen = await render(<WorktreeToolbarPicker {...props()} />);
    await expect
      .element(screen.getByRole("button", { name: "Worktree: Main checkout" }))
      .toBeVisible();
  });
  it("shows the physical basename and exposes its full path", async () => {
    const screen = await render(
      <WorktreeToolbarPicker {...props()} selectedPath="/trees/physical-folder" />,
    );
    const button = screen.getByRole("button", { name: "Worktree: physical-folder" });
    await expect.element(button).toHaveAttribute("title", "/trees/physical-folder");
    await button.click();
    await expect.element(page.getByRole("menuitem", { name: "Create worktree…" })).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Search worktrees" })).toBeVisible();
  });
  it.each([360, 900])(
    "remains geometrically centered at %ipx with unequal neighboring labels",
    async (width) => {
      const screen = await render(
        <div style={{ width }}>
          <BranchToolbarLayout>
            <div className="min-w-0 truncate">P</div>
            <div className="flex min-w-0 justify-center">
              <WorktreeToolbarPicker {...props()} />
            </div>
            <div className="min-w-0 truncate">
              an-extremely-long-branch-name-that-must-not-displace-the-center
            </div>
          </BranchToolbarLayout>
        </div>,
      );
      const button = screen.getByRole("button", { name: "Worktree: Main checkout" }).element();
      const layout = button.closest(".grid")!.getBoundingClientRect();
      const control = button.getBoundingClientRect();
      expect(
        Math.abs(control.left + control.width / 2 - (layout.left + layout.width / 2)),
      ).toBeLessThan(1);
      expect(control.width).toBeLessThan(layout.width / 3);
    },
  );
});
