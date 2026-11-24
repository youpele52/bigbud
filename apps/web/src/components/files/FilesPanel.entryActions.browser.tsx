import "../../index.css";

import type { ProjectEntry } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  entryActions: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
  deleteEntry: vi.fn(),
  loadDirectory: vi.fn(),
  onOpenFile: vi.fn(),
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    projects: {
      entryActions: mocks.entryActions,
      writeFile: mocks.writeFile,
      createDirectory: mocks.createDirectory,
      deleteEntry: mocks.deleteEntry,
    },
  }),
}));

import { renderFilesPanelTreeBody } from "./FilesPanel.body";
import { FilesPanelContextMenu } from "./FilesPanel.contextMenu";
import { useFilesPanelEntryActionsUi } from "./FilesPanel.entryActions";
import { FILE_EDIT_READ_ONLY_COPY } from "./fileEditEligibility";

const root = "/srv/project";
const entries: ProjectEntry[] = [
  { path: "docs", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const docs: ProjectEntry[] = [{ path: "docs/guide.md", kind: "file", parentPath: "docs" }];

function Harness(props: {
  readonly executionTargetId?: string;
  readonly menuPath?: string;
  readonly expanded?: Record<string, boolean>;
  readonly toggled?: string;
}) {
  const expandedDirectories = props.expanded ?? {};
  const ui = useFilesPanelEntryActionsUi({
    workspaceRoot: root,
    executionTargetId: props.executionTargetId,
    expandedDirectories,
    loadDirectory: mocks.loadDirectory,
    onOpenFile: mocks.onOpenFile,
    resolvedTheme: "dark",
  });
  if (props.toggled) ui.noteDirectoryToggled(props.toggled);
  return (
    <div className="w-96">
      <div data-testid="header">{ui.headerActions}</div>
      {renderFilesPanelTreeBody({
        showLoading: false,
        error: null,
        entries,
        pendingEntry: ui.pendingEntrySlot,
        workspaceRoot: root,
        previewPath: null,
        resolvedTheme: "dark",
        expandedDirectories,
        directoryStateByPath: {
          "": { entries, loading: false, error: null },
          docs: { entries: docs, loading: false, error: null },
        } as never,
        onToggleDirectory: () => undefined,
        onOpenFile: () => undefined,
        onOpenContextMenu: () => undefined,
      })}
      <FilesPanelContextMenu
        workspaceRoot={root}
        contextMenuState={
          props.menuPath ? { path: `${root}/${props.menuPath}`, kind: "file", x: 40, y: 40 } : null
        }
        onClose={() => undefined}
        {...ui.contextMenuDelete}
      />
      {ui.deleteDialog}
    </div>
  );
}

const allowed = {
  createFile: { allowed: true },
  createFolder: { allowed: true },
  delete: { allowed: true, permanent: false },
};

async function choose(label: "New file" | "New folder") {
  await page.getByRole("button", { name: "New file or folder" }).click();
  await page.getByRole("menuitem", { name: label }).click();
}

describe("Files panel create and delete", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.entryActions.mockResolvedValue(allowed);
  });

  it("creates an empty file exclusively at the root and opens it", async () => {
    mocks.writeFile.mockResolvedValue({ relativePath: "notes.md" });
    await render(<Harness />);
    await choose("New file");
    const input = page.getByRole("textbox", { name: "New file name" });
    await expect.element(input).toHaveFocus();
    await input.fill("notes.md");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(mocks.onOpenFile).toHaveBeenCalled());
    expect(mocks.writeFile).toHaveBeenCalledWith({
      cwd: root,
      relativePath: "notes.md",
      contents: "",
      createOnly: true,
    });
    expect(mocks.onOpenFile).toHaveBeenCalledWith({ path: "notes.md", kind: "file" });
    expect(mocks.loadDirectory).toHaveBeenCalledWith("", { force: true });
    await expect.element(input).not.toBeInTheDocument();
  });

  it("shows a name collision inline and keeps the input; Esc cancels", async () => {
    mocks.writeFile.mockRejectedValue({ alreadyExists: true, message: "exists" });
    await render(<Harness />);
    await choose("New file");
    const input = page.getByRole("textbox", { name: "New file name" });
    await input.fill("README.md");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("README.md already exists here. Choose another name.");
    await expect.element(input).toBeVisible();
    expect(mocks.onOpenFile).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expect.element(input).not.toBeInTheDocument();
  });

  it("creates a folder inside the folder the user last opened", async () => {
    mocks.createDirectory.mockResolvedValue({ relativePath: "docs/drafts" });
    await render(<Harness expanded={{ docs: true }} toggled="docs" />);
    await choose("New folder");
    const input = page.getByRole("textbox", { name: "New folder name" });
    await input.fill("drafts");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(mocks.createDirectory).toHaveBeenCalledWith({
        cwd: root,
        relativePath: "docs/drafts",
      }),
    );
    expect(mocks.loadDirectory).toHaveBeenCalledWith("docs", { force: true });
    expect(mocks.onOpenFile).not.toHaveBeenCalled();
  });

  it("groups the context menu and always confirms Delete before deleting", async () => {
    mocks.deleteEntry.mockResolvedValue({ relativePath: "README.md", disposition: "trashed" });
    await render(<Harness menuPath="README.md" />);
    await vi.waitFor(() => expect(mocks.entryActions).toHaveBeenCalled());
    const items = [...document.querySelectorAll("[data-file-menu-item]")].map((item) =>
      item.getAttribute("data-file-menu-item"),
    );
    expect(items).toEqual([
      "open-in-file-viewer",
      "open-externally",
      "copy-relative-path",
      "copy-path",
      "delete",
    ]);
    expect(document.querySelectorAll('[role="separator"]').length).toBe(2);
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await expect.element(page.getByText("Delete README.md?")).toBeVisible();
    await expect.element(page.getByText("The file moves to the Trash.")).toBeVisible();
    expect(mocks.deleteEntry).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await vi.waitFor(() =>
      expect(mocks.deleteEntry).toHaveBeenCalledWith({
        cwd: root,
        relativePath: "README.md",
        expectedKind: "file",
      }),
    );
  });

  it("keeps Direct SSH read only with the editor copy", async () => {
    const reason = "directSshPendingOwner" as const;
    mocks.entryActions.mockResolvedValue({
      createFile: { allowed: false, reason },
      createFolder: { allowed: false, reason },
      delete: { allowed: false, reason, permanent: true },
    });
    await render(
      <Harness executionTargetId="ssh:host=example&transport=direct-ssh" menuPath="README.md" />,
    );
    await vi.waitFor(() => expect(mocks.entryActions).toHaveBeenCalled());
    const del = page.getByRole("menuitem", { name: "Delete…" });
    await expect.element(del).toHaveAttribute("aria-disabled", "true");
    await expect.element(del).toHaveAttribute("title", FILE_EDIT_READ_ONLY_COPY[reason]);
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: "New file or folder" }).click();
    for (const name of ["New file", "New folder"]) {
      await expect
        .element(page.getByRole("menuitem", { name }))
        .toHaveAttribute("aria-disabled", "true");
    }
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.deleteEntry).not.toHaveBeenCalled();
  });
});
