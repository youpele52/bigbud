import "../../index.css";

import type { CliProxyVersion, ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useBannerDismissalStore } from "../../stores/ui/bannerDismissal.store";
import { ProviderStatusBanner } from "../chat/provider/ProviderStatusBanner";
import { CliProxyVersionDetails } from "../settings/ProviderCard.cliProxyVersion";
import { CliProxyVersionNotice } from "./CliProxyVersionNotice";

const version: CliProxyVersion = {
  recommendedVersion: "8.0.51",
  runtimeVersion: null,
  installedVersion: "8.0.30",
  installation: "homebrew",
  updateSource: "installed",
};

afterEach(() => {
  useBannerDismissalStore.setState({ dismissed: new Set(), serverRunId: null });
  document.body.innerHTML = "";
});

it.each(["chat", "settings"] as const)(
  "uses the shared %s warning banner with nonblocking semantics and safe manual-only guidance",
  async (placement) => {
    await render(<CliProxyVersionNotice version={version} placement={placement} />);
    await expect.element(page.getByRole("status")).toHaveAttribute("data-slot", "alert");
    await expect.element(page.getByRole("status")).toHaveAttribute("data-status", "warning");
    expect(document.querySelectorAll("[data-chat-banner]")).toHaveLength(
      placement === "chat" ? 1 : 0,
    );
    await expect.element(page.getByRole("status")).toHaveClass("border-l-warning");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Older versions remain usable");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("connected server version could not be verified");
    await page.getByText("Manual update guidance").click();
    await expect.element(page.getByText("brew upgrade cliproxyapi", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("wait until active requests finish");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("does not update or restart CLIProxyAPI automatically");
  },
);

it("shares recommendation dismissal across settings/chat, remounts and routine polling", async () => {
  useBannerDismissalStore.getState().observeRun("run-one");
  const screen = await render(<CliProxyVersionNotice version={version} placement="chat" />);
  await page.getByLabelText("Dismiss CLIProxyAPI update recommendation").click();
  await screen.rerender(
    <CliProxyVersionNotice
      version={{ ...version, runtimeVersion: "8.0.31", updateSource: "runtime" }}
      placement="chat"
    />,
  );
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await screen.unmount();
  const settings = await render(<CliProxyVersionDetails version={{ ...version }} />);
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await expect
    .element(page.getByText(/Connected server version:/))
    .toHaveTextContent("could not be verified");
  useBannerDismissalStore.getState().observeRun("run-two");
  await expect.element(page.getByRole("status")).toBeVisible();
  await page.getByLabelText("Dismiss CLIProxyAPI update recommendation").click();
  await settings.rerender(
    <CliProxyVersionDetails version={{ ...version, recommendedVersion: "8.0.52" }} />,
  );
  await expect.element(page.getByRole("status")).toBeVisible();
});

it("does not hide an independently reported authentication error when dismissed", async () => {
  const status: ServerProvider = {
    provider: "cliProxy",
    enabled: true,
    installed: true,
    version: null,
    status: "error",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-11-02T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    message: "Authentication required",
  };
  await render(
    <>
      <ProviderStatusBanner status={status} />
      <CliProxyVersionNotice version={version} placement="chat" />
    </>,
  );
  await page.getByLabelText("Dismiss CLIProxyAPI update recommendation").click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Authentication required");
});

it("calls only the supplied read-only recheck and uses generic guidance for unknown installations", async () => {
  const refresh = vi.fn();
  await render(
    <CliProxyVersionDetails
      version={{ ...version, installation: "unknown" }}
      onCheckAgain={refresh}
    />,
  );
  await page.getByRole("button", { name: "Check again" }).click();
  expect(refresh).toHaveBeenCalledTimes(1);
  await page.getByText("Manual update guidance").click();
  await expect.element(page.getByText(/Update using your installation method/)).toBeVisible();
  expect(document.body.textContent).not.toContain("brew upgrade");
});

it("shows unknown or newer version details without an outdated-runtime claim", async () => {
  const screen = await render(<CliProxyVersionDetails version={undefined} />);
  await expect
    .element(page.getByText(/Connected server version:/))
    .toHaveTextContent("could not be verified");
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  await screen.rerender(
    <CliProxyVersionDetails
      version={{ ...version, runtimeVersion: "8.0.100", updateSource: undefined }}
    />,
  );
  await expect.element(page.getByText(/Connected server version:/)).toHaveTextContent("8.0.100");
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
});
