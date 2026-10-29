import "../../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { ChatBanner } from "../common/ChatBanner";
import { render } from "vitest-browser-react";
import type { ServerOpencodeV2ThreadToolsSetupResult } from "@bigbud/contracts/server/server.opencodeV2ThreadToolsSetup";
import { OpenCodeSetupStatus } from "./OpenCodeSetupStatus";

const queued: ServerOpencodeV2ThreadToolsSetupResult = {
  status: "required",
  activationState: "waiting-for-idle",
  directory: "/workspace",
  artifactDirectoryUri: "",
  artifactDigest: "",
  issuerKeyId: "",
  configAddition: { plugins: [] },
  jobId: "a".repeat(32),
  interestId: "b".repeat(32),
  message: "Waiting for an active native prompt to finish.",
};

it("foregrounds the real queue reason and cancel control, then shows expiry and retry", async () => {
  const onCancel = vi.fn(),
    onRetry = vi.fn();
  const screen = await render(
    <OpenCodeSetupStatus result={queued} onCancel={onCancel} onRetry={onRetry} />,
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("OpenCode setup queued — waiting for idle");
  await expect.element(screen.getByRole("status")).toHaveTextContent(queued.message);
  await expect.element(screen.getByRole("button", { name: "Retry setup" })).toBeDisabled();
  await screen.getByRole("button", { name: "Cancel this setup request" }).click();
  expect(onCancel).toHaveBeenCalledOnce();
  await screen.rerender(
    <OpenCodeSetupStatus
      result={{
        ...queued,
        activationState: "deferred",
        message: "Setup deadline expired while waiting for native idle.",
      }}
      onCancel={onCancel}
      onRetry={onRetry}
    />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Setup deadline expired");
  await expect
    .element(screen.getByRole("button", { name: "Cancel this setup request" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Retry setup" }).click();
  expect(onRetry).toHaveBeenCalledOnce();
  await screen.unmount();
});

afterEach(async () => {
  useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
  await page.viewport(1280, 800);
});

it.each([375, 1280])("matches shared banner layout and dismissal at %ipx", async (width) => {
  await page.viewport(width, 900);
  const message = "Native configuration could not be verified. ".repeat(30);
  const result = { ...queued, activationState: "blocked" as const, message };
  const screen = await render(
    <>
      <ChatBanner title="Reference" description="Shared banner" onDismiss={vi.fn()} />
      <OpenCodeSetupStatus
        threadId="setup-layout"
        result={result}
        error={message}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />
    </>,
  );
  try {
    const banners = [...document.querySelectorAll<HTMLElement>("[data-chat-banner]")];
    expect(banners).toHaveLength(2);
    expect(banners[1]!.getBoundingClientRect().width).toBe(
      banners[0]!.getBoundingClientRect().width,
    );
    const setup = screen.getByRole("status").element() as HTMLElement;
    expect(setup.querySelectorAll("[title]")).toHaveLength(1);
    const description = setup.querySelector<HTMLElement>("[title]")!;
    expect(getComputedStyle(description).webkitLineClamp).toBe("3");
    expect(getComputedStyle(setup).fontSize).toBe("14px");
    expect(setup).toHaveClass("border-destructive/32");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await screen.getByRole("button", { name: "Dismiss OpenCode setup status" }).click();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-chat-banner]")).toHaveLength(1);
    await screen.rerender(
      <OpenCodeSetupStatus
        threadId="setup-layout"
        result={{ ...result, message: "Updated setup status" }}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
