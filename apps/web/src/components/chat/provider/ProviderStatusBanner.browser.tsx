import "../../../index.css";

import type { ServerProvider } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";

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
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
    document.body.innerHTML = "";
  });
  it("keeps a dismissed condition hidden across navigation and routine probes, but not in a different thread", async () => {
    const status = provider({ message: "Provider warning" });
    const first = await render(<ProviderStatusBanner threadId="thread-one" status={status} />);
    await page.getByLabelText("Dismiss provider status").click();
    await first.unmount();
    const reopened = await render(
      <ProviderStatusBanner threadId="thread-one" status={{ ...status, checkedAt: "new-probe" }} />,
    );
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await reopened.rerender(<ProviderStatusBanner threadId="thread-two" status={status} />);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await reopened.rerender(
      <ProviderStatusBanner threadId="thread-one" status={{ ...status, version: "new-version" }} />,
    );
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps copy changes closed but allows independently scoped providers", async () => {
    const screen = await render(
      <ProviderStatusBanner status={provider({ message: "The first status message" })} />,
    );

    await expect.element(page.getByRole("alert")).toHaveTextContent("The first status message");
    await page.getByLabelText("Dismiss provider status").click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await screen.rerender(
      <ProviderStatusBanner status={provider({ message: "The second status message" })} />,
    );
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await screen.rerender(
      <ProviderStatusBanner
        status={provider({ provider: "codex", message: "Independent provider" })}
      />,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent("Independent provider");
  });
});
