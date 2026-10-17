import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ACCESS_MODE_INFO_DURATION_MS, AccessModeInfoBanner } from "./AccessModeInfoBanner";

describe("AccessModeInfoBanner", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("only shows after an explicit mode change, then auto-dismisses", async () => {
    const props = {
      threadId: "thread-1",
      provider: "opencodeV2" as const,
      accessModeChangeId: 0,
    };
    const screen = await render(<AccessModeInfoBanner {...props} runtimeMode="full-access" />);
    const status = page.getByRole("status");

    await expect.element(status).not.toBeInTheDocument();

    await screen.rerender(<AccessModeInfoBanner {...props} runtimeMode="auto-accept-edits" />);
    await expect.element(status).not.toBeInTheDocument();

    await screen.rerender(
      <AccessModeInfoBanner {...props} accessModeChangeId={1} runtimeMode="auto-accept-edits" />,
    );
    await expect.element(status).toHaveTextContent("Access: Auto-accept edits");
    await expect.element(status).toHaveClass("bg-transparent");
    await expect.element(status).not.toHaveClass("bg-warning/4");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, ACCESS_MODE_INFO_DURATION_MS + 50));
    await expect.element(status).not.toBeInTheDocument();
  });

  it("gates on OpenCode v2 and hides when the provider or thread changes", async () => {
    const props = {
      threadId: "thread-1",
      runtimeMode: "full-access" as const,
      accessModeChangeId: 1,
    };
    const screen = await render(<AccessModeInfoBanner {...props} provider="codex" />);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();

    await screen.rerender(<AccessModeInfoBanner {...props} provider="opencodeV2" />);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();

    await screen.rerender(
      <AccessModeInfoBanner {...props} provider="opencodeV2" accessModeChangeId={2} />,
    );
    await expect.element(page.getByRole("status")).toBeInTheDocument();
    await page.getByRole("button", { name: "Dismiss access information" }).click();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();

    await screen.rerender(
      <AccessModeInfoBanner {...props} provider="opencode" accessModeChangeId={2} />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    await screen.rerender(
      <AccessModeInfoBanner {...props} provider="opencodeV2" accessModeChangeId={2} />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();

    await screen.rerender(
      <AccessModeInfoBanner
        {...props}
        provider="opencodeV2"
        threadId="thread-2"
        accessModeChangeId={2}
      />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });

  it("only shows configuration-specific content after a mode-change event", async () => {
    const props = { provider: "opencodeV2" as const, runtimeMode: "auto-accept-edits" as const };
    const screen = await render(
      <AccessModeInfoBanner {...props} threadId="thread-1" accessModeChangeId={0} />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();

    await screen.rerender(
      <AccessModeInfoBanner
        {...props}
        threadId="thread-1"
        connectionMode="isolated"
        accessModeChangeId={0}
      />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();

    await screen.rerender(
      <AccessModeInfoBanner
        {...props}
        threadId="thread-1"
        connectionMode="isolated"
        accessModeChangeId={1}
      />,
    );
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("bounded canonical file edits");

    await screen.rerender(
      <AccessModeInfoBanner
        {...props}
        threadId="thread-2"
        connectionMode="isolated"
        accessModeChangeId={1}
      />,
    );
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });
});
