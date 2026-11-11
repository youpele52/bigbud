import "../../index.css";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadTerminalDrawerRenameEditor } from "./ThreadTerminalDrawerRenameEditor";

it.each(["Cancel", "Reset", "Save"])(
  "clicking %s runs only its intended rename action",
  async (action) => {
    const commit = vi.fn(),
      cancel = vi.fn(),
      reset = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      const finish = (callback: () => void) => {
        callback();
        setOpen(false);
      };
      return open ? (
        <ThreadTerminalDrawerRenameEditor
          value="Draft"
          placeholder="Terminal"
          onChange={vi.fn()}
          onCommit={() => finish(commit)}
          onCancel={() => finish(cancel)}
          onReset={() => finish(reset)}
          autoFocus
        />
      ) : null;
    }
    const screen = await render(<Harness />);
    try {
      await screen
        .getByRole("button", {
          name: `${action} terminal ${action === "Cancel" ? "rename" : "name"}`,
        })
        .click();
      expect(commit).toHaveBeenCalledTimes(action === "Save" ? 1 : 0);
      expect(cancel).toHaveBeenCalledTimes(action === "Cancel" ? 1 : 0);
      expect(reset).toHaveBeenCalledTimes(action === "Reset" ? 1 : 0);
    } finally {
      await screen.unmount();
    }
  },
);

it("saves when focus leaves the entire editor, but ignores IME Enter/Escape", async () => {
  const commit = vi.fn(),
    cancel = vi.fn();
  const screen = await render(
    <div>
      <ThreadTerminalDrawerRenameEditor
        value="Draft"
        placeholder="Terminal"
        onChange={vi.fn()}
        onCommit={commit}
        onCancel={cancel}
        onReset={vi.fn()}
        autoFocus
      />
      <button>Outside</button>
    </div>,
  );
  try {
    const input = screen.getByRole("textbox").element();
    for (const key of ["Enter", "Escape"])
      input.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true }));
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Outside" }).click();
    expect(commit).toHaveBeenCalledOnce();
  } finally {
    await screen.unmount();
  }
});
