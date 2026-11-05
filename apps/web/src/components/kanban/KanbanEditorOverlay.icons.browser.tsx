import "../../index.css";

import { CollapseIcon, ExpandIcon } from "@hugeicons/core-free-icons";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { KanbanEditorOverlay } from "./KanbanEditorOverlay";

function expectIcon(element: Element, artwork: typeof ExpandIcon) {
  const icon = element.querySelector("svg")!;
  expect(icon).not.toBeNull();
  expect(icon.getAttribute("aria-hidden")).toBe("true");
  expect(Array.from(icon.children, (child) => child.getAttribute("d"))).toEqual(
    artwork.map(([, attributes]) => attributes.d ?? null),
  );
}

it("switches between Hugeicons expand and collapse artwork without changing the toggle", async () => {
  const mounted = await render(
    <KanbanEditorOverlay
      content=""
      cwd={undefined}
      error={null}
      mode="create"
      saving={false}
      selectedStatus="todo"
      title="Example"
      onCancel={() => {}}
      onContentChange={() => {}}
      onDelete={null}
      onSave={async () => {}}
      onStatusChange={() => {}}
      onTitleChange={() => {}}
    />,
  );
  try {
    const expand = page.getByRole("button", { name: "Enter fullscreen editor", exact: true });
    expectIcon(expand.element(), ExpandIcon);
    await expect.element(expand).toHaveAttribute("aria-pressed", "false");
    await expand.click();

    const collapse = page.getByRole("button", { name: "Exit fullscreen editor", exact: true });
    await expect.element(collapse).toHaveAttribute("aria-pressed", "true");
    expectIcon(collapse.element(), CollapseIcon);
    await collapse.click();

    await expect.element(expand).toHaveAttribute("aria-pressed", "false");
    expectIcon(expand.element(), ExpandIcon);
  } finally {
    await mounted.unmount();
  }
});
