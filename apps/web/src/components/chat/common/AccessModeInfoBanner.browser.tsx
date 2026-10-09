import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { AccessModeInfoBanner } from "./AccessModeInfoBanner";

describe("AccessModeInfoBanner", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows initially, stays dismissed on rerender, and reappears on every access-mode change", async () => {
    const props = { threadId: "thread-1", provider: "opencodeV2" as const };
    const screen = await render(<AccessModeInfoBanner {...props} runtimeMode="full-access" />);
    const status = page.getByRole("status");
    const dismiss = page.getByRole("button", { name: "Dismiss access information" });

    await expect.element(status).toHaveTextContent("Access: Full access");
    await expect.element(status).toHaveClass("bg-transparent");
    await expect.element(status).not.toHaveClass("bg-warning/4");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await dismiss.click();
    await expect.element(status).not.toBeInTheDocument();

    await screen.rerender(<AccessModeInfoBanner {...props} runtimeMode="full-access" />);
    await expect.element(status).not.toBeInTheDocument();

    await screen.rerender(<AccessModeInfoBanner {...props} runtimeMode="auto-accept-edits" />);
    await expect.element(status).toHaveTextContent("Access: Auto-accept edits");
    await dismiss.click();
    await screen.rerender(<AccessModeInfoBanner {...props} runtimeMode="approval-required" />);
    await expect.element(status).toHaveTextContent("Access: Supervised");
    await dismiss.click();
    await screen.rerender(<AccessModeInfoBanner {...props} runtimeMode="full-access" />);
    await expect.element(status).toHaveTextContent("Access: Full access");
  });

  it("gates on the selected provider and resets dismissal when that provider changes", async () => {
    const props = { threadId: "thread-1", runtimeMode: "full-access" as const };
    const screen = await render(<AccessModeInfoBanner {...props} provider="codex" />);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();

    await screen.rerender(<AccessModeInfoBanner {...props} provider="opencodeV2" />);
    await expect.element(page.getByRole("status")).toBeInTheDocument();
    await page.getByRole("button", { name: "Dismiss access information" }).click();
    await screen.rerender(<AccessModeInfoBanner {...props} provider="opencode" />);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    await screen.rerender(<AccessModeInfoBanner {...props} provider="opencodeV2" />);
    await expect.element(page.getByRole("status")).toBeInTheDocument();
  });

  it("reappears with configuration-specific content and resets for another thread", async () => {
    const props = { provider: "opencodeV2" as const, runtimeMode: "auto-accept-edits" as const };
    const screen = await render(<AccessModeInfoBanner {...props} threadId="thread-1" />);
    await expect.element(page.getByRole("status")).toHaveTextContent("permits native file edits");
    await page.getByRole("button", { name: "Dismiss access information" }).click();

    await screen.rerender(
      <AccessModeInfoBanner {...props} threadId="thread-1" connectionMode="isolated" />,
    );
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("bounded canonical file edits");
    await page.getByRole("button", { name: "Dismiss access information" }).click();

    await screen.rerender(
      <AccessModeInfoBanner {...props} threadId="thread-2" connectionMode="isolated" />,
    );
    await expect.element(page.getByRole("status")).toBeInTheDocument();
  });
});
