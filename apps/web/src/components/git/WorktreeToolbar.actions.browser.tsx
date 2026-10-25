import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { WorktreeEntry } from "@bigbud/contracts/workspace/worktrees.ts";
import { Menu, MenuTrigger, MenuPopup } from "../ui/menu";
import { WorktreeToolbarActions } from "./WorktreeToolbar.actions";

const { copy, openEditor, toast } = vi.hoisted(() => ({
  copy: vi.fn().mockResolvedValue(undefined),
  openEditor: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
}));
vi.mock("../../lib/clipboard/copyText", () => ({ copyTextToClipboard: copy }));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    server: { getConfig: async () => ({ availableEditors: ["vscode"] }) },
    shell: { openInEditor: openEditor },
  }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));

const entry: WorktreeEntry = {
  path: "/trees/physical-folder",
  name: "physical-folder",
  branch: "different-branch",
  head: "abc",
  identity: "1:2",
  main: false,
  bare: false,
  locked: null,
  prunable: null,
};
const callbacks = () => ({ onSelect: vi.fn(), onDelete: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
});

async function mount(local = true, main = false) {
  return render(
    <Menu defaultOpen>
      <MenuTrigger>Actions</MenuTrigger>
      <MenuPopup>
        <WorktreeToolbarActions
          entry={{ ...entry, main }}
          local={local}
          disabled={false}
          {...callbacks()}
        />
      </MenuPopup>
    </Menu>,
  );
}

it.each([
  ["Copy worktree name", "physical-folder"],
  ["Copy worktree path", "/trees/physical-folder"],
])("copies %s without substituting its branch", async (label, value) => {
  await mount();
  await page.getByRole("menuitem", { name: label }).click();
  expect(copy).toHaveBeenCalledExactlyOnceWith(value);
});
it("opens the physical local folder through the existing preferred-editor helper", async () => {
  await mount();
  await page.getByRole("menuitem", { name: "Open in editor" }).click();
  await vi.waitFor(() => expect(openEditor).toHaveBeenCalledExactlyOnceWith(entry.path, "vscode"));
});
it("never offers rename or delete for the main checkout", async () => {
  await mount(true, true);
  await expect.element(page.getByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: "Delete…" })).not.toBeInTheDocument();
});
it("does not send remote paths to a local editor or enable remote physical mutation", async () => {
  await mount(false);
  for (const name of ["Open in editor", "Delete…"])
    await expect
      .element(page.getByRole("menuitem", { name }))
      .toHaveAttribute("aria-disabled", "true");
  expect(openEditor).not.toHaveBeenCalled();
});
it("leaves folder renaming to existing agent terminal tools", async () => {
  await mount();
  await expect.element(page.getByRole("menuitem", { name: "Rename…" })).not.toBeInTheDocument();
});
