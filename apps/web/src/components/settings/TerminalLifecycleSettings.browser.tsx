import "../../index.css";

import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { TerminalLifecycleSettings } from "./TerminalLifecycleSettings";

const mocks = vi.hoisted(() => ({ keepRunning: false, updateSettings: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (value: { terminalsKeepRunningAfterQuit: boolean }) => unknown) =>
    select({ terminalsKeepRunningAfterQuit: mocks.keepRunning }),
  useUpdateSettings: () => ({ updateSettings: mocks.updateSettings }),
}));

beforeEach(() => {
  mocks.keepRunning = false;
  mocks.updateSettings.mockReset();
});

it("turns keeping terminals running after quit on through the server setting", async () => {
  const screen = await render(<TerminalLifecycleSettings platform="MacIntel" />);
  try {
    const toggle = page.getByRole("switch", { name: "Keep terminals running after quitting" });
    await expect.element(toggle).not.toBeChecked();
    await expect
      .element(page.getByText("Idle terminals still close after 10 minutes.", { exact: false }))
      .toBeVisible();
    await toggle.click();
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      terminalsKeepRunningAfterQuit: true,
    });
  } finally {
    await screen.unmount();
  }
});

it("cannot be turned on on Windows", async () => {
  const screen = await render(<TerminalLifecycleSettings platform="Win32" />);
  try {
    const toggle = page.getByRole("switch", { name: "Keep terminals running after quitting" });
    await expect.element(toggle).toBeDisabled();
    await expect
      .element(page.getByText("Not available on Windows yet.", { exact: false }))
      .toBeVisible();
    await toggle.click({ force: true });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
