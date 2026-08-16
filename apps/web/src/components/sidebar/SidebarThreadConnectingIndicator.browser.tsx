import "../../index.css";

import type { SVGProps } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  SIDEBAR_CONNECTING_LABEL_DELAY_MS,
  SidebarThreadConnectingIndicator,
} from "./SidebarThreadConnectingIndicator";

const EPISODE_STARTED_AT = "2026-08-14T12:00:00.000Z";

function TestProviderIcon(props: SVGProps<SVGSVGElement>) {
  return <svg data-testid="provider-logo" {...props} />;
}

function ConnectingHarness({
  connecting,
  connectingStartedAt,
  providerColor = "text-muted-foreground",
}: {
  connecting: boolean;
  connectingStartedAt: string;
  providerColor?: string;
}) {
  return (
    <div data-testid="indicator-host">
      <TestProviderIcon
        aria-hidden="true"
        className={`size-3 shrink-0 transition-[color,opacity] duration-200 ease-out ${
          connecting ? "animate-breathe text-warning motion-reduce:animate-none" : providerColor
        }`}
      />
      {connecting ? (
        <SidebarThreadConnectingIndicator connectingStartedAt={connectingStartedAt} />
      ) : null}
    </div>
  );
}

function connectingLabel(): HTMLElement {
  return page.getByText("connecting", { exact: true }).element() as HTMLElement;
}

async function expectConnectingLabelVisible(): Promise<void> {
  await vi.waitFor(() => {
    expect(connectingLabel().classList).not.toContain("sr-only");
  });
}

describe("SidebarThreadConnectingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(EPISODE_STARTED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the provider logo mounted while its connecting color transitions", async () => {
    await render(<ConnectingHarness connecting connectingStartedAt={EPISODE_STARTED_AT} />);

    const host = page.getByTestId("indicator-host").element();
    const logo = page.getByTestId("provider-logo").element();
    const label = connectingLabel();

    expect(logo.classList).toContain("text-warning");
    expect(logo.classList).toContain("animate-breathe");
    expect(logo.classList).toContain("motion-reduce:animate-none");
    expect(logo.classList).toContain("transition-[color,opacity]");
    expect(logo.getAttribute("aria-hidden")).toBe("true");
    expect(label.className).toBe("sr-only");
    expect(label.textContent).toBe("connecting");
    expect(label.closest("[aria-live]")).toBeNull();
    expect(host.querySelector(".rounded-full")).toBeNull();
  });

  it("retains the provider logo DOM node across status colors", async () => {
    const screen = await render(
      <ConnectingHarness connecting connectingStartedAt={EPISODE_STARTED_AT} />,
    );
    const logo = page.getByTestId("provider-logo").element();

    await screen.rerender(
      <ConnectingHarness
        connecting={false}
        connectingStartedAt={EPISODE_STARTED_AT}
        providerColor="text-info-foreground"
      />,
    );

    expect(page.getByTestId("provider-logo").element()).toBe(logo);
    expect(logo.classList).toContain("text-info-foreground");
    expect(logo.classList).not.toContain("animate-breathe");

    await screen.rerender(
      <ConnectingHarness
        connecting={false}
        connectingStartedAt={EPISODE_STARTED_AT}
        providerColor="text-success"
      />,
    );
    expect(page.getByTestId("provider-logo").element()).toBe(logo);
    expect(logo.classList).toContain("text-success");
  });

  it("reveals the lowercase label at exactly ten seconds", async () => {
    await render(<ConnectingHarness connecting connectingStartedAt={EPISODE_STARTED_AT} />);

    await vi.advanceTimersByTimeAsync(SIDEBAR_CONNECTING_LABEL_DELAY_MS - 1);
    expect(connectingLabel().className).toBe("sr-only");

    await vi.advanceTimersByTimeAsync(1);
    await expectConnectingLabelVisible();
    expect(connectingLabel().className).toBe("shrink-0 text-[10px] text-warning");
    expect(connectingLabel().textContent).toBe("connecting");
    expect(page.getByTestId("provider-logo").element().classList).toContain("text-warning");
    expect(page.getByTestId("provider-logo").element().classList).toContain("animate-breathe");
    expect(page.getByTestId("indicator-host").element().querySelector(".rounded-full")).toBeNull();
  });

  it("cancels a stale reveal and gives a later connecting episode a fresh delay", async () => {
    const screen = await render(
      <ConnectingHarness connecting connectingStartedAt={EPISODE_STARTED_AT} />,
    );

    await vi.advanceTimersByTimeAsync(4_000);
    await screen.rerender(
      <ConnectingHarness connecting={false} connectingStartedAt={EPISODE_STARTED_AT} />,
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_CONNECTING_LABEL_DELAY_MS);
    expect(page.getByText("connecting", { exact: true }).query()).toBeNull();

    const laterEpisodeStartedAt = new Date(Date.now()).toISOString();
    await screen.rerender(
      <ConnectingHarness connecting connectingStartedAt={laterEpisodeStartedAt} />,
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_CONNECTING_LABEL_DELAY_MS - 1);
    expect(connectingLabel().className).toBe("sr-only");
    await vi.advanceTimersByTimeAsync(1);
    await expectConnectingLabelVisible();
  });

  it("hides a revealed stale attempt when a new timestamp arrives", async () => {
    const screen = await render(
      <ConnectingHarness connecting connectingStartedAt={EPISODE_STARTED_AT} />,
    );
    await vi.advanceTimersByTimeAsync(SIDEBAR_CONNECTING_LABEL_DELAY_MS);
    await expectConnectingLabelVisible();

    const laterEpisodeStartedAt = new Date(Date.now()).toISOString();
    await screen.rerender(
      <ConnectingHarness connecting connectingStartedAt={laterEpisodeStartedAt} />,
    );
    expect(connectingLabel().className).toBe("sr-only");
  });

  it("reveals immediately on remount when the timestamp delay already elapsed", async () => {
    vi.setSystemTime(new Date(Date.parse(EPISODE_STARTED_AT) + SIDEBAR_CONNECTING_LABEL_DELAY_MS));

    await render(<ConnectingHarness connecting connectingStartedAt={EPISODE_STARTED_AT} />);

    expect(connectingLabel().classList).not.toContain("sr-only");
    expect(connectingLabel().textContent).toBe("connecting");
  });
});
