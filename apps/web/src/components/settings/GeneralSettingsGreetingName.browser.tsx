import "../../index.css";

import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ name: "", save: vi.fn(), apply: vi.fn(), toast: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, greetingName: mocks.name };
    return selector ? selector(settings) : settings;
  },
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { updateSettings: mocks.save } }),
}));
vi.mock("../../rpc/serverState", () => ({ applySettingsUpdated: mocks.apply }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import { GeneralSettingsGreetingName } from "./GeneralSettingsGreetingName";
import { GeneralSettingsSection } from "./GeneralSettingsSection";

describe("shared greeting name setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.name = "";
    mocks.save.mockImplementation(async ({ greetingName }: { greetingName: string }) => ({
      ...DEFAULT_UNIFIED_SETTINGS,
      greetingName,
    }));
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is the first setting in General, with an optional name and shared-instance description", async () => {
    const screen = await render(<GeneralSettingsSection />);
    expect(document.querySelector("h3")?.textContent).toBe("What should bigbud call you?");
    const input = screen.getByRole("textbox", { name: "What should bigbud call you?" });
    await expect.element(input).toHaveValue("");
    expect(input.element().getAttribute("maxlength")).toBe("64");
    await expect.element(screen.getByText(/Shared across this bigbud instance/)).toBeVisible();
  });

  it("saves on blur through the server RPC and acknowledges only a successful response", async () => {
    const screen = await render(<GeneralSettingsGreetingName />);
    const input = screen.getByRole("textbox", { name: "What should bigbud call you?" });
    await input.fill("  小雨  ");
    expect(mocks.save).not.toHaveBeenCalled();
    (input.element() as HTMLInputElement).blur();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ greetingName: "小雨" }));
    await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
    await expect.element(input).toHaveValue("小雨");
  });

  it("saves on Enter, can reset a saved nickname, and can clear by erasing the input", async () => {
    mocks.name = "Youpele";
    const screen = await render(<GeneralSettingsGreetingName />);
    await page.getByRole("button", { name: "Reset greeting name to default" }).click();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ greetingName: "" }));
    mocks.name = "";
    await screen.rerender(<GeneralSettingsGreetingName />);
    const input = screen.getByRole("textbox", { name: "What should bigbud call you?" });
    await input.fill("  Éloïse  ");
    await input.click();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ greetingName: "Éloïse" }));
    await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
    mocks.name = "Éloïse";
    await screen.rerender(<GeneralSettingsGreetingName />);
    await input.fill("");
    (input.element() as HTMLInputElement).blur();
    await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(3));
    expect(mocks.save).toHaveBeenLastCalledWith({ greetingName: "" });
  });

  it("retains failed edits for retry, reports errors, and does not change shared state optimistically", async () => {
    mocks.save.mockRejectedValueOnce(new Error("Server disconnected"));
    const screen = await render(<GeneralSettingsGreetingName />);
    const input = screen.getByRole("textbox", { name: "What should bigbud call you?" });
    await input.fill("Youpele");
    (input.element() as HTMLInputElement).blur();
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "error",
        title: "Unable to save greeting name",
        description: "Server disconnected",
      }),
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue("Youpele");
    await input.click();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  });

  it("updates from other clients without discarding a dirty edit", async () => {
    const screen = await render(<GeneralSettingsGreetingName />);
    const input = screen.getByRole("textbox", { name: "What should bigbud call you?" });
    mocks.name = "Remote nickname";
    await screen.rerender(<GeneralSettingsGreetingName />);
    await expect.element(input).toHaveValue("Remote nickname");
    await input.fill("My edit");
    mocks.name = "Another client";
    await screen.rerender(<GeneralSettingsGreetingName />);
    await expect.element(input).toHaveValue("My edit");
  });

  it("awaits persistence and deduplicates Enter plus the resulting blur", async () => {
    let finish!: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise<typeof DEFAULT_UNIFIED_SETTINGS>((resolve) => {
          finish = resolve;
        }),
    );
    const screen = await render(<GeneralSettingsGreetingName />);
    const input = screen.getByRole("textbox", { name: "What should bigbud call you?" });
    await input.fill("Youpele");
    await input.click();
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toBeDisabled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
    finish({ ...DEFAULT_UNIFIED_SETTINGS, greetingName: "Youpele" });
    await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
    await expect.element(input).not.toBeDisabled();
    await expect.element(input).toHaveValue("Youpele");
  });
});
