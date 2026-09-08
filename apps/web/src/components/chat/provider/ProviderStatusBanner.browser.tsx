import "../../../index.css";

import type { ServerProvider } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderStatusBanner } from "./ProviderStatusBanner";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    provider: "opencode",
    enabled: true,
    installed: true,
    version: "1.17.18",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-06T12:00:00.000Z",
    initialProbeComplete: true,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("ProviderStatusBanner", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("re-shows after dismissal when the provider status key changes", async () => {
    const screen = await render(
      <ProviderStatusBanner status={provider({ message: "The first status message" })} />,
    );

    await expect.element(page.getByRole("alert")).toHaveTextContent("The first status message");
    await page.getByLabelText("Dismiss").click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await screen.rerender(
      <ProviderStatusBanner status={provider({ message: "The second status message" })} />,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent("The second status message");
    await expect
      .element(page.getByText("The second status message"))
      .toHaveAttribute("title", "The second status message");
  });
});
