import "../../index.css";

import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { TerminalLifecycleSettings } from "./TerminalLifecycleSettings";

const mocks = vi.hoisted(() => ({
  keepRunning: false,
  hostEnabled: true,
  updateSettings: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (value: { terminalsKeepRunningAfterQuit: boolean }) => unknown) =>
    select({ terminalsKeepRunningAfterQuit: mocks.keepRunning }),
  useUpdateSettings: () => ({ updateSettings: mocks.updateSettings }),
}));
vi.mock("../../rpc/serverState", () => ({
  useServerTerminalHostEnabled: () => mocks.hostEnabled,
}));

beforeEach(() => {
  mocks.keepRunning = false;
  mocks.hostEnabled = true;
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

it("cannot be turned on while the background terminal host is off", async () => {
  mocks.hostEnabled = false;
  const screen = await render(<TerminalLifecycleSettings platform="MacIntel" />);
  try {
    const toggle = page.getByRole("switch", { name: "Keep terminals running after quitting" });
    await expect.element(toggle).toBeDisabled();
    await expect
      .element(
        page.getByText("Available when the background terminal host is enabled.", {
          exact: false,
        }),
      )
      .toBeVisible();
    await toggle.click({ force: true });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
