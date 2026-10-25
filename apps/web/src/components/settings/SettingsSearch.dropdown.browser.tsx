import "../../index.css";

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));

import { SettingsSearch } from "./SettingsSearch";

function SettingsSearchFixture({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);

  return (
    <div className="flex items-start gap-8">
      <SettingsSearch query={query} onQueryChange={setQuery} />
      <div>
        <h2>Current settings</h2>
        <button type="button">Outside control</button>
      </div>
    </div>
  );
}

describe("Settings search dropdown", () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.navigate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps existing queries hidden until the search field is focused", async () => {
    await render(<SettingsSearchFixture initialQuery="brows" />);
    const input = page.getByRole("searchbox", { name: "Search settings" });

    await expect.element(input).toHaveValue("brows");
    await expect.element(input).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("settings-search-results")).toBeNull();

    await input.click();
    await expect
      .element(page.getByRole("button", { name: "Browser AI", exact: true }))
      .toBeVisible();
    await expect.element(input).toHaveAttribute("aria-expanded", "true");
  });

  it("hides results on outside clicks without clearing the query, then reopens on focus", async () => {
    await render(<SettingsSearchFixture />);
    const input = page.getByRole("searchbox", { name: "Search settings" });
    await input.fill("brows");
    await expect
      .element(page.getByRole("button", { name: "Browser AI", exact: true }))
      .toBeVisible();

    await page.getByRole("heading", { name: "Current settings" }).click();
    await expect.element(input).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("settings-search-results")).toBeNull();
    await expect.element(input).toHaveValue("brows");
    expect(mocks.navigate).not.toHaveBeenCalled();

    await input.click();
    await expect
      .element(page.getByRole("button", { name: "Browser AI", exact: true }))
      .toBeVisible();
  });

  it("closes after clicking a result and reopens with the same query on refocus", async () => {
    await render(<SettingsSearchFixture />);
    const input = page.getByRole("searchbox", { name: "Search settings" });
    await input.fill("brows");
    await page.getByRole("button", { name: "Default agent browser AI", exact: true }).click();

    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings/ai", replace: true });
    await expect.element(input).toHaveAttribute("aria-expanded", "false");
    await expect.element(input).toHaveValue("brows");
    await expect.element(input).not.toHaveFocus();
    expect(document.getElementById("settings-search-results")).toBeNull();

    await input.click();
    await expect
      .element(page.getByRole("button", { name: "Browser AI", exact: true }))
      .toBeVisible();
  });

  it("closes after selecting the first result with Enter", async () => {
    await render(<SettingsSearchFixture />);
    const input = page.getByRole("searchbox", { name: "Search settings" });
    await input.fill("brows");
    await userEvent.keyboard("{Enter}");

    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings/ai", replace: true });
    await expect.element(input).toHaveAttribute("aria-expanded", "false");
    await expect.element(input).toHaveValue("brows");
    await expect.element(input).not.toHaveFocus();
  });

  it("keeps results available while tabbing through them and closes when focus leaves", async () => {
    await render(<SettingsSearchFixture />);
    const input = page.getByRole("searchbox", { name: "Search settings" });
    await input.fill("brows");
    await userEvent.tab();
    await expect
      .element(page.getByRole("button", { name: "Browser AI", exact: true }))
      .toHaveFocus();
    await expect.element(input).toHaveAttribute("aria-expanded", "true");

    await page.getByRole("button", { name: "Outside control" }).click();
    await expect.element(input).toHaveAttribute("aria-expanded", "false");
    await expect.element(input).toHaveValue("brows");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("preserves Escape behavior by clearing the query and blurring the field", async () => {
    await render(<SettingsSearchFixture />);
    const input = page.getByRole("searchbox", { name: "Search settings" });
    await input.fill("brows");
    await userEvent.keyboard("{Escape}");

    await expect.element(input).toHaveValue("");
    await expect.element(input).not.toHaveFocus();
    await expect.element(input).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("settings-search-results")).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
