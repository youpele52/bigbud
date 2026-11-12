import type { TerminalShellSettings as ShellSettings } from "@bigbud/contracts/core/settings.terminalShell.ts";
import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { TerminalShellSettings } from "./TerminalShellSettings";

const mocks = vi.hoisted(() => ({
  value: {
    version: 1,
    origin: "explicit",
    hostDefaults: {},
    suggestionPolicy: "off",
  } as ShellSettings,
  discover: vi.fn(),
  persist: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (value: { terminalShells: ShellSettings }) => unknown) =>
    select({ terminalShells: mocks.value }),
  persistServerSettings: mocks.persist,
}));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ terminal: { shellProfiles: mocks.discover } }),
}));
const inventory = {
  host: { kind: "local", hostId: "local" },
  localDefaultsEnabled: true,
  profiles: [
    {
      profileId: "zsh",
      host: { kind: "local", hostId: "local" },
      kind: "zsh",
      executable: "/bin/zsh",
      args: [],
      platform: "darwin",
      availability: "available",
      displayName: "zsh",
      integration: { status: "disabled" },
    },
  ],
};
beforeEach(() => {
  mocks.value = {
    version: 1,
    origin: "explicit",
    hostDefaults: { remote: { kind: "profile", profileId: "remote" } },
    suggestionPolicy: "off",
  };
  mocks.discover.mockReset().mockResolvedValue(inventory);
  mocks.persist.mockReset().mockImplementation(async (patch) => {
    mocks.value = {
      ...mocks.value,
      hostDefaults: { ...mocks.value.hostDefaults, local: patch.terminalShells.localDefault },
    };
  });
});
it("loads host-local choices without writing settings and saves via keyboard without changing other hosts", async () => {
  const screen = await render(<TerminalShellSettings />);
  try {
    const select = page.getByRole("combobox", { name: "Default local shell" });
    await expect.element(select).toBeEnabled();
    await expect.element(select).toHaveTextContent("Automatic (existing behavior)");
    expect(mocks.discover).toHaveBeenCalledExactlyOnceWith({ scope: "local-settings" });
    expect(mocks.persist).not.toHaveBeenCalled();
    await select.click();
    await userEvent.keyboard("{End}{Enter}");
    await expect.poll(() => mocks.persist.mock.calls.length).toBe(1);
    expect(mocks.persist).toHaveBeenCalledWith({
      terminalShells: { localDefault: { kind: "profile", profileId: "zsh" } },
    });
    await expect.element(select).toHaveTextContent("zsh");
    expect(mocks.value.hostDefaults.remote).toEqual({ kind: "profile", profileId: "remote" });
    await expect.element(page.getByText("Off · not qualified")).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
it("keeps Windows gated and stored choices untouched", async () => {
  mocks.discover.mockResolvedValue({ ...inventory, profiles: [], localDefaultsEnabled: false });
  mocks.value = {
    ...mocks.value,
    hostDefaults: {
      ...mocks.value.hostDefaults,
      local: { kind: "profile", profileId: "saved-windows" },
    },
  };
  const screen = await render(<TerminalShellSettings />);
  try {
    await expect
      .element(page.getByText("Not active on this platform · saved choices preserved"))
      .toBeVisible();
    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.value.hostDefaults.local).toEqual({ kind: "profile", profileId: "saved-windows" });
  } finally {
    await screen.unmount();
  }
});
it("retains an unavailable saved default and recovers discovery on refresh", async () => {
  mocks.value = {
    ...mocks.value,
    hostDefaults: { ...mocks.value.hostDefaults, local: { kind: "profile", profileId: "missing" } },
  };
  mocks.discover.mockRejectedValueOnce(new Error("Discovery failed"));
  const screen = await render(<TerminalShellSettings />);
  try {
    await expect.element(page.getByRole("alert")).toHaveTextContent("Discovery failed");
    await page.getByRole("button", { name: "Refresh local shells" }).click();
    const select = page.getByRole("combobox", { name: "Default local shell" });
    await expect.element(select).toBeEnabled();
    await expect.element(select).toHaveTextContent("Saved profile (unavailable)");
    expect(mocks.persist).not.toHaveBeenCalled();
    await select.click();
    await page.getByRole("option", { name: "Automatic (existing behavior)" }).click();
    await expect.element(select).toHaveTextContent("Automatic (existing behavior)");
  } finally {
    await screen.unmount();
  }
});
it("failed persistence keeps the previous selection and allows retry", async () => {
  mocks.persist.mockRejectedValueOnce(new Error("Disk write failed"));
  const screen = await render(<TerminalShellSettings />);
  try {
    const select = page.getByRole("combobox", { name: "Default local shell" });
    await expect.element(select).toBeEnabled();
    await select.click();
    await page.getByRole("option", { name: "zsh", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Disk write failed");
    await expect.element(select).toHaveTextContent("Automatic (existing behavior)");
    await expect.element(select).toBeEnabled();
  } finally {
    await screen.unmount();
  }
});
