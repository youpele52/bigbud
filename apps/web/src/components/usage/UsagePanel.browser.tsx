import "../../index.css";

import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { getUsageSummary, state } = vi.hoisted(() => ({
  getUsageSummary: vi.fn(),
  state: { providers: [] as ServerProvider[] },
}));
vi.mock("~/rpc/nativeApi", () => {
  const api = { server: { getUsageSummary, refreshUsageLimits: vi.fn() } };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});
vi.mock("~/rpc/serverState", () => ({ useServerProviders: () => state.providers }));

import { UsagePanel } from "./UsagePanel";
import { STANDALONE_PAGE_WIDTH_CLASS } from "../standalone/StandalonePageContent";
import { expectCenteredStatuses } from "../common/CenteredStatus.browser.utils";

const totals = {
  usedTokens: 12345,
  inputTokens: 12300,
  cachedInputTokens: 0,
  outputTokens: 45,
  reasoningOutputTokens: 0,
  turnCount: 1,
};
const summary: ServerUsageSummaryResult = {
  range: "24h",
  generatedAt: "2026-10-11T12:00:00Z",
  historyStatus: "ready",
  providerCoverage: [],
  totals,
  buckets: [],
  providers: [],
  models: [],
  favoriteProvider: { id: "codex", label: "raw", usedTokens: 12345, turnCount: 1 },
  favoriteModel: null,
  favoriteMode: null,
  streakDays: 11,
};
let mounted: Awaited<ReturnType<typeof render>> | undefined;

function makeRouter() {
  return createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory(),
    isServer: false,
  });
}

describe("Usage panel", () => {
  beforeEach(() => {
    getUsageSummary.mockReset().mockResolvedValue(summary);
    state.providers = (
      [
        ["codex", "codex-app-server"],
        ["claudeAgent", "claude-agent-sdk"],
        ["cursor", "cursor-dashboard"],
        ["opencode", "opencode-go-api"],
      ] as const
    ).map(([provider, source]) => ({
      provider,
      enabled: true,
      installed: true,
      version: "1",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: summary.generatedAt,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        source,
        status: "available",
        checkedAt: summary.generatedAt,
        windows: [
          {
            id: "week",
            kind: "seven-day",
            label: "Weekly limit",
            utilization: 25,
            resetAt: "2026-10-15T12:00:00Z",
          },
          { id: "five", kind: "five-hour", label: "Five-hour limit", utilization: 50 },
        ],
      },
    }));
  });
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    vi.restoreAllMocks();
  });

  it("shows only compact rolling overview and all provider windows with working full-page navigation", async () => {
    const router = makeRouter();
    const navigate = vi.spyOn(router, "navigate").mockResolvedValue();
    mounted = await render(
      <RouterContextProvider router={router}>
        <div style={{ width: 280 }}>
          <UsagePanel visible />
        </div>
      </RouterContextProvider>,
    );
    await expect.element(mounted.getByText("12,345")).toBeVisible();
    await expect.element(mounted.getByText("11d")).toBeVisible();
    await expect.element(mounted.getByText("Codex", { exact: true }).first()).toBeVisible();
    expect(getUsageSummary).toHaveBeenCalledExactlyOnceWith({ range: "24h" });
    await expect.element(mounted.getByRole("heading", { name: "24-hour overview" })).toBeVisible();
    for (const label of ["Total tokens", "Top provider", "Top model"])
      await expect.element(mounted.getByRole("heading", { name: label })).toBeVisible();
    expect(
      mounted.getByText("Last 24 hours · rolling token totals and top provider/model").all(),
    ).toHaveLength(0);
    for (const label of ["Claude", "Codex", "Cursor", "OpenCode Go"]) {
      await expect
        .element(mounted.getByRole("region", { name: `${label} subscription limits` }))
        .toBeVisible();
    }
    expect(mounted.getByText("Weekly limit", { exact: true }).all()).toHaveLength(4);
    expect(mounted.getByText("Five-hour limit", { exact: true }).all()).toHaveLength(4);
    expect(document.querySelectorAll(".recharts-wrapper")).toHaveLength(0);
    expect(document.querySelector('[aria-label="Select usage range"]')).toBeNull();
    const grid = mounted
      .getByRole("heading", { name: "Total tokens" })
      .element()
      .closest('[data-slot="card"]')?.parentElement;
    expect(getComputedStyle(grid!).gridTemplateColumns.split(" ")).toHaveLength(2);
    const link = mounted.getByRole("link", { name: "View full usage" });
    expect(link.element().getAttribute("href")).toBe("/usage");
    await link.click();
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/usage" }));
  });

  it("preserves successful data on refresh failures and ignores closed-tab results", async () => {
    const router = makeRouter();
    let tick: (() => void) | undefined;
    const originalInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
      milliseconds: number,
    ) => {
      if (milliseconds === 60_000) tick = callback;
      return originalInterval(callback, milliseconds);
    }) as typeof setInterval);
    const content = (visible: boolean) => (
      <RouterContextProvider router={router}>
        <UsagePanel visible={visible} />
      </RouterContextProvider>
    );
    mounted = await render(content(false));
    expect(getUsageSummary).not.toHaveBeenCalled();
    await mounted.rerender(content(true));
    await expect.element(mounted.getByText("12,345")).toBeVisible();
    expect(tick).toBeDefined();
    getUsageSummary.mockRejectedValueOnce(new Error("offline"));
    tick!();
    await expect
      .element(mounted.getByRole("status"))
      .toHaveTextContent("Showing last successful data");
    expectCenteredStatuses(mounted.getByRole("status").element().parentElement!);
    expect(mounted.getByRole("status").element().querySelector("svg")).toBeNull();
    await expect.element(mounted.getByText("12,345")).toBeVisible();
    let finish!: (value: ServerUsageSummaryResult) => void;
    getUsageSummary.mockReturnValueOnce(
      new Promise<ServerUsageSummaryResult>((resolve) => {
        finish = resolve;
      }),
    );
    tick!();
    await mounted.rerender(content(false));
    finish({ ...summary, totals: { ...totals, usedTokens: 999 } });
    await expect.element(mounted.getByText("12,345")).toBeVisible();
    expect(mounted.getByText("999", { exact: true }).all()).toHaveLength(0);
  });

  it("centers the compact breathing logo while loading", async () => {
    let finish!: (value: ServerUsageSummaryResult) => void;
    getUsageSummary.mockReturnValueOnce(
      new Promise<ServerUsageSummaryResult>((resolve) => {
        finish = resolve;
      }),
    );
    mounted = await render(
      <RouterContextProvider router={makeRouter()}>
        <div style={{ width: 280 }} data-testid="surface">
          <UsagePanel visible />
        </div>
      </RouterContextProvider>,
    );
    await expect.element(mounted.getByText("Loading usage", { exact: true })).toBeVisible();
    expectCenteredStatuses(mounted.getByTestId("surface").element());
    expect(
      mounted
        .getByText("Loading usage", { exact: true })
        .element()
        .closest('[data-slot="centered-status"]')
        ?.getAttribute("data-loading"),
    ).toBe("true");
    finish(summary);
    await expect.element(mounted.getByText("12,345")).toBeVisible();
  });

  it.each([280, 1200])(
    "shares System's centered maximum content width in a %ipx panel",
    async (width) => {
      mounted = await render(
        <RouterContextProvider router={makeRouter()}>
          <div style={{ width }}>
            <UsagePanel visible />
          </div>
        </RouterContextProvider>,
      );
      await expect.element(mounted.getByText("12,345")).toBeVisible();
      const content = mounted
        .getByRole("heading", { name: "Usage", exact: true })
        .element().parentElement!;
      for (const className of STANDALONE_PAGE_WIDTH_CLASS.split(" "))
        expect(content.classList.contains(className)).toBe(true);
      const bounds = content.getBoundingClientRect();
      const host = content.parentElement!.parentElement!.getBoundingClientRect();
      const maximum = 56 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      expect(bounds.width).toBeCloseTo(Math.min(width, maximum));
      expect(bounds.left - host.left).toBeCloseTo(host.right - bounds.right);
      const metricsGrid = mounted
        .getByRole("heading", { name: "Total tokens" })
        .element()
        .closest('[data-slot="card"]')?.parentElement;
      expect(getComputedStyle(metricsGrid!).gridTemplateColumns.split(" ")).toHaveLength(
        width >= 800 ? 4 : 2,
      );
      const overviewCard = mounted
        .getByRole("heading", { name: "Total tokens" })
        .element()
        .closest('[data-slot="card"]')!
        .getBoundingClientRect();
      expect(overviewCard.left).toBeGreaterThan(bounds.left);
      expect(overviewCard.right).toBeLessThan(bounds.right);
      for (const progress of mounted.getByRole("progressbar").all()) {
        const progressBounds = progress.element().getBoundingClientRect();
        expect(progressBounds.left).toBeGreaterThan(bounds.left);
        expect(progressBounds.right).toBeLessThan(bounds.right);
      }
      const provider = mounted
        .getByRole("region", { name: "Claude subscription limits" })
        .element();
      const windows = provider.querySelectorAll('[role="progressbar"]');
      const windowGrid = provider.querySelector(".grid")!;
      expect(getComputedStyle(windowGrid).gridTemplateColumns.split(" ")).toHaveLength(
        width >= 640 ? 2 : 1,
      );
      const first = windows[0]!.getBoundingClientRect();
      const second = windows[1]!.getBoundingClientRect();
      if (width >= 640) {
        expect(second.top).toBeCloseTo(first.top);
        expect(second.left).toBeGreaterThan(first.right);
      } else {
        expect(second.top).toBeGreaterThan(first.bottom);
      }
      expect(content.scrollWidth).toBe(content.clientWidth);
    },
  );

  it("pauses when the document is hidden and resumes immediately when visible", async () => {
    const router = makeRouter();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    mounted = await render(
      <RouterContextProvider router={router}>
        <UsagePanel visible />
      </RouterContextProvider>,
    );
    expect(getUsageSummary).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.element(mounted.getByText("12,345")).toBeVisible();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getUsageSummary).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => getUsageSummary.mock.calls.length).toBe(2);
  });

  it("does not invent allowances for disabled or unavailable providers", async () => {
    state.providers = state.providers.map((provider, index) => ({
      ...provider,
      enabled: index !== 0,
      usageLimits:
        index === 0 ? provider.usageLimits : { ...provider.usageLimits!, status: "unavailable" },
    }));
    mounted = await render(
      <RouterContextProvider router={makeRouter()}>
        <UsagePanel visible />
      </RouterContextProvider>,
    );
    await expect
      .element(mounted.getByText("Subscription limits unavailable for enabled providers."))
      .toBeVisible();
    expect(mounted.getByText("Weekly limit", { exact: true }).all()).toHaveLength(0);
  });
});
