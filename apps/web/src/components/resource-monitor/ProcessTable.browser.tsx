import "../../index.css";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { ProcessTable, type ProcessQueryControls } from "./ProcessTable";

const onChange = vi.fn();

function ProcessTableFixture() {
  const [controls, setControls] = useState<ProcessQueryControls>({
    search: "worker",
    sort: "cpu",
    descending: true,
  });
  return (
    <ProcessTable
      rows={[]}
      controls={controls}
      onControlsChange={(next) => {
        onChange(next);
        setControls(next);
      }}
      onNextPage={() => undefined}
      onPreviousPage={() => undefined}
      hasNextPage={false}
      hasPreviousPage={false}
      status="ready"
      truncated={false}
    />
  );
}

afterEach(() => vi.clearAllMocks());

it("uses the app select for every process sort without changing search or direction", async () => {
  const screen = await render(<ProcessTableFixture />);
  try {
    const trigger = screen.getByRole("combobox", { name: "Sort processes" });
    await expect.element(trigger).toHaveAttribute("data-slot", "select-trigger");
    for (const [label, value] of [
      ["Memory", "memory"],
      ["Name", "name"],
      ["PID", "pid"],
      ["CPU", "cpu"],
    ] as const) {
      await trigger.click();
      const option = page.getByRole("option", { name: label, exact: true });
      await expect.element(option).toHaveAttribute("data-slot", "select-item");
      await option.click();
      await expect.element(trigger).toHaveTextContent(label);
      expect(onChange).toHaveBeenLastCalledWith({
        search: "worker",
        sort: value,
        descending: true,
      });
    }
    await screen.getByRole("button", { name: "Sort ascending" }).click();
    expect(onChange).toHaveBeenLastCalledWith({ search: "worker", sort: "cpu", descending: false });
    await expect.element(screen.getByRole("textbox")).toHaveValue("worker");
  } finally {
    await screen.unmount();
  }
});

it("supports keyboard selection and dismissal without applying a cancelled sort", async () => {
  const screen = await render(<ProcessTableFixture />);
  try {
    const trigger = screen.getByRole("combobox", { name: "Sort processes" });
    await trigger.click();
    await userEvent.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    await trigger.click();
    await userEvent.keyboard("{End}{Enter}");
    await expect.element(trigger).toHaveTextContent("PID");
    expect(onChange).toHaveBeenLastCalledWith({ search: "worker", sort: "pid", descending: true });
  } finally {
    await screen.unmount();
  }
});
