import "../../index.css";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SidebarNewProjectFlow } from "./SidebarNewProjectFlow";

describe("SidebarNewProjectFlow", () => {
  function mount(
    options: {
      desktop?: boolean;
      pending?: boolean;
      picking?: boolean;
      folder?: string;
      error?: string;
    } = {},
  ) {
    const onAdd = vi.fn();
    const onCancel = vi.fn();
    const onPickFolder = vi.fn();
    function Harness() {
      const [cwd, setCwd] = useState(options.folder ?? "");
      return (
        <SidebarNewProjectFlow
          isElectron={options.desktop ?? true}
          newCwd={cwd}
          isAddingProject={options.pending ?? false}
          isPickingFolder={options.picking ?? false}
          addProjectError={options.error ?? null}
          addProjectInputRef={createRef<HTMLInputElement>()}
          onCwdChange={setCwd}
          onClearError={vi.fn()}
          onPickFolder={onPickFolder}
          onAdd={onAdd}
          onCancel={onCancel}
        />
      );
    }
    return {
      result: render(<Harness />).then((screen) => ({
        [Symbol.asyncDispose]: () => screen.unmount(),
      })),
      onAdd,
      onCancel,
      onPickFolder,
    };
  }

  it("uses a modal with required name, browse-only folder and Enter submission", async () => {
    const harness = mount();
    await using _ = await harness.result;
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Add project", exact: true }))
      .toBeDisabled();
    expect(document.querySelectorAll("input:not([readonly])")).toHaveLength(1);
    await expect.element(page.getByLabelText("Folder (optional)")).toHaveAttribute("readonly");
    await expect.element(page.getByLabelText("Project name")).toHaveFocus();
    await expect
      .element(page.getByLabelText("Folder (optional)"))
      .toHaveAttribute("placeholder", "Choose a folder");
    await expect
      .element(page.getByRole("dialog"))
      .toHaveTextContent("Give your project a name and optionally choose a folder.");
    expect(page.getByRole("dialog").element().textContent).not.toMatch(/managed|storage|server/iu);
    const folderControl = page
      .getByLabelText("Folder (optional)")
      .element()
      .closest('[data-slot="input-control"]')!;
    const browse = page.getByRole("button", { name: "Browse" }).element();
    expect(folderControl).toHaveClass("border-border", "bg-card", "min-w-0", "flex-1");
    expect(folderControl.getBoundingClientRect().height).toBeLessThanOrEqual(36);
    expect(
      Math.abs(
        folderControl.getBoundingClientRect().height - browse.getBoundingClientRect().height,
      ),
    ).toBeLessThanOrEqual(4);
    await page.getByRole("button", { name: "Browse" }).click();
    expect(harness.onPickFolder).toHaveBeenCalledOnce();
    await page.getByLabelText("Project name").fill("New project");
    await userEvent.keyboard("{Enter}");
    expect(harness.onAdd).toHaveBeenCalledWith("New project");
  });

  it("limits the desktop dialog to two-thirds of its previous 36rem width", async () => {
    await page.viewport(1280, 900);
    const harness = mount();
    await using _ = await harness.result;
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const dialog = page.getByRole("dialog").element();
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    expect(Number.parseFloat(getComputedStyle(dialog).maxWidth)).toBeCloseTo(24 * rem);
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(24 * rem);
  });

  it("shows selected folders read-only and clears the optional selection", async () => {
    const harness = mount({ folder: "/tmp/project" });
    await using _ = await harness.result;
    await expect.element(page.getByLabelText("Folder (optional)")).toHaveValue("/tmp/project");
    await expect.element(page.getByLabelText("Folder (optional)")).toHaveAttribute("readonly");
    await page.getByLabelText("Project name").fill("Keep this name");
    await page.getByRole("button", { name: "Clear folder" }).click();
    await expect.element(page.getByLabelText("Folder (optional)")).toHaveValue("");
    await expect.element(page.getByLabelText("Project name")).toHaveValue("Keep this name");
  });

  it("explains web browsing limitations and preserves name-only creation", async () => {
    const harness = mount({ desktop: false });
    await using _ = await harness.result;
    await expect.element(page.getByRole("button", { name: "Browse" })).not.toBeInTheDocument();
    await expect
      .element(page.getByText("Open the desktop app to browse for a local folder."))
      .toBeInTheDocument();
    expect(document.querySelectorAll("input:not([readonly])")).toHaveLength(1);
    await expect.element(page.getByLabelText("Folder (optional)")).toHaveAttribute("readonly");
    await page.getByLabelText("Project name").fill("Managed project");
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    expect(harness.onAdd).toHaveBeenCalledWith("Managed project");
  });

  it.each([{ pending: true }, { picking: true }])(
    "prevents submit and dismissal while busy: %j",
    async (options) => {
      const harness = mount({ ...options, folder: "/tmp/project" });
      await using _ = await harness.result;
      await expect.element(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: /Adding…|Add project/u }))
        .toBeDisabled();
      await userEvent.keyboard("{Escape}");
      expect(harness.onCancel).not.toHaveBeenCalled();
      expect(harness.onAdd).not.toHaveBeenCalled();
    },
  );

  it("shows creation errors and allows Escape cancellation", async () => {
    const harness = mount({ error: "Unable to create project" });
    await using _ = await harness.result;
    await expect.element(page.getByRole("alert")).toHaveTextContent("Unable to create project");
    await userEvent.keyboard("{Escape}");
    expect(harness.onCancel).toHaveBeenCalledOnce();
  });
});
