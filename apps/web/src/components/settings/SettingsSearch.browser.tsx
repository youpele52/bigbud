import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsSearchProvider } from "./SettingsSearch.context";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function SearchableSettings({ query }: { query: string }) {
  return (
    <SettingsSearchProvider query={query} terms={["General"]}>
      <SettingsPageContainer>
        <SettingsSection title="Appearance">
          <SettingsRow title="Theme" description="Choose the application theme." />
        </SettingsSection>
        <SettingsSection title="Terminal">
          <SettingsRow title="Terminal font size" description="Choose the terminal font size." />
        </SettingsSection>
      </SettingsPageContainer>
    </SettingsSearchProvider>
  );
}

describe("Settings search filtering", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("hides unmatched settings and their empty sections", async () => {
    await render(<SearchableSettings query="terminal size" />);

    await expect.element(page.getByRole("heading", { name: "Terminal font size" })).toBeVisible();
    expect(document.querySelector("h3")?.closest("[hidden]")).not.toBeNull();
    expect(getComputedStyle(document.querySelector("section")!).display).toBe("none");
  });

  it("shows an accessible empty state when no settings match", async () => {
    await render(<SearchableSettings query="unrelated" />);

    await expect.element(page.getByRole("status")).toHaveTextContent("No settings found.");
  });
});
