import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  enabled: true,
  mode: "background" as "background" | "foreground",
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ computerUseEnabled: mocks.enabled, computerUseDeliveryMode: mocks.mode }),
  useUpdateSettings: () => ({ updateSettings: mocks.updateSettings }),
}));

import { ComputerUseDeliverySettingsRow } from "./ComputerUseDeliverySettingsRow";

describe("Computer Use interaction setting", () => {
  beforeEach(() => {
    mocks.updateSettings.mockClear();
    mocks.enabled = true;
  });

  it.each(["foreground", "background"] as const)(
    "persists %s through server settings",
    async (next) => {
      mocks.mode = next === "foreground" ? "background" : "foreground";
      const screen = await render(<ComputerUseDeliverySettingsRow />);
      try {
        await page.getByRole("combobox", { name: "Computer use interaction preference" }).click();
        await page
          .getByRole("option", {
            name: next === "foreground" ? "Foreground" : "Background",
            exact: true,
          })
          .click();
        expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
          computerUseDeliveryMode: next,
        });
      } finally {
        await screen.unmount();
      }
    },
  );
});
