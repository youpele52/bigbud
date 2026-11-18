import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  location: { pathname: "/settings/ai", hash: "" },
  updateSettings: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useLocation: () => mocks.location }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: mocks.updateSettings }),
}));
vi.mock("../../rpc/serverState", () => ({ useServerProviders: () => [] }));
vi.mock("../../models/provider", () => ({
  resolveAppModelSelectionState: () => ({ provider: "codex", model: "test-model" }),
  getCustomModelOptionsByProvider: () => ({}),
}));
vi.mock("../chat/provider/ProviderModelPicker", () => ({
  ProviderModelPicker: () => <button type="button">Choose generation model</button>,
}));
vi.mock("../chat/provider/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("./AiSettingsSection.promptSuggestions", () => ({
  PromptSuggestionSettingsRows: () => null,
}));

import { AiSettingsSection } from "./AiSettingsSection";
import { SettingsSearchProvider } from "./SettingsSearch.context";

afterEach(() => {
  mocks.location = { pathname: "/settings/ai", hash: "" };
  mocks.updateSettings.mockClear();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("scrolls to and focuses the model selector without opening it or changing settings", async () => {
  mocks.location = { ...mocks.location, hash: "text-generation-model" };
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const screen = await render(<AiSettingsSection />);
  const button = screen.getByRole("button", { name: "Choose generation model" });
  await expect.element(button).toHaveFocus();
  expect(scroll).toHaveBeenCalledWith({ block: "center" });
  expect(document.activeElement?.closest("#text-generation-model")).not.toBeNull();
  expect(mocks.updateSettings).not.toHaveBeenCalled();
});

it("does not steal focus for ordinary AI settings navigation", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const screen = await render(<AiSettingsSection />);
  await expect
    .element(screen.getByRole("button", { name: "Choose generation model" }))
    .not.toHaveFocus();
  expect(scroll).not.toHaveBeenCalled();
});

it("reveals and focuses the target despite an existing unrelated settings search", async () => {
  const section = (
    <SettingsSearchProvider query="unrelated-search-term" terms={[]}>
      <AiSettingsSection />
    </SettingsSearchProvider>
  );
  const screen = await render(section);
  expect(document.querySelector("#text-generation-model")?.closest("[hidden]")).not.toBeNull();
  mocks.location = { ...mocks.location, hash: "text-generation-model" };
  await screen.rerender(
    <SettingsSearchProvider query="unrelated-search-term" terms={[]}>
      <AiSettingsSection />
    </SettingsSearchProvider>,
  );
  const button = screen.getByRole("button", { name: "Choose generation model" });
  await expect.element(button).toBeVisible();
  await expect.element(button).toHaveFocus();
  expect(mocks.updateSettings).not.toHaveBeenCalled();
});

it("handles a deep link while the settings section is already mounted", async () => {
  const screen = await render(<AiSettingsSection />);
  mocks.location = { ...mocks.location, hash: "text-generation-model" };
  await screen.rerender(<AiSettingsSection />);
  await expect
    .element(screen.getByRole("button", { name: "Choose generation model" }))
    .toHaveFocus();
  expect(mocks.updateSettings).not.toHaveBeenCalled();
});
