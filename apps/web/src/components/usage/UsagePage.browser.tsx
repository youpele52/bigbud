import "../../index.css";

import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { getUsageSummary, state } = vi.hoisted(() => ({
  getUsageSummary: vi.fn(),
  state: { providers: [] as ServerProvider[] },
}));

vi.mock("~/rpc/nativeApi", () => {
  const api = { server: { getUsageSummary } };
  return { readNativeApi: () => api };
});
vi.mock("~/rpc/serverState", () => ({ useServerProviders: () => state.providers }));
vi.mock("../standalone/StandaloneChatPageShell", () => ({
  StandaloneChatPageShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));
vi.mock("../standalone/StandaloneChatPageHeader", () => ({
  StandaloneChatPageHeader: ({ title, actions }: { title: string; actions: ReactNode }) => (
    <header>
      {title}
      {actions}
    </header>
  ),
}));

import { UsagePage } from "./UsagePage";

const totals = {
  usedTokens: 100,
  inputTokens: 60,
  cachedInputTokens: 10,
  outputTokens: 20,
  reasoningOutputTokens: 10,
  turnCount: 1,
};
const summary: ServerUsageSummaryResult = {
  range: "7d",
  generatedAt: "2026-10-08T12:00:00Z",
  historyStatus: "ready",
  providerCoverage: [],
  totals,
  buckets: [{ ...totals, bucketStart: "2026-10-08T00:00:00Z" }],
  providers: [{ id: "codex", label: "Codex", usedTokens: 100, turnCount: 1 }],
  models: [{ id: "gpt-5", label: "GPT-5", usedTokens: 100, turnCount: 1 }],
  favoriteProvider: null,
  favoriteModel: null,
  favoriteMode: null,
  streakDays: 1,
};

let mounted: Awaited<ReturnType<typeof render>> | undefined;

describe("Usage page heading hierarchy", () => {
  beforeEach(() => {
    getUsageSummary.mockReset().mockResolvedValue(summary);
    state.providers = (
      [
        ["codex", "codex-app-server"],
        ["claudeAgent", "claude-agent-sdk"],
        ["cursor", "cursor-dashboard"],
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
        windows: [{ id: "monthly", kind: "monthly", label: "Monthly limit", utilization: 59 }],
      },
    }));
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
  });

  it("categorizes usage with consistently spaced H2s outside cards and H3s inside", async () => {
    mounted = await render(<UsagePage />);
    await expect
      .element(page.getByRole("heading", { level: 2, name: "Overview" }))
      .toBeInTheDocument();
    const headings = Array.from(document.querySelectorAll("h2"));
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Overview",
      "Token usage",
      "Breakdown",
      "Subscription limits",
    ]);
    for (const heading of headings) {
      expect(heading.closest('[data-slot="card"]')).toBeNull();
      expect(heading.closest("section")?.classList.contains("space-y-4")).toBe(true);
      expect(getComputedStyle(heading).fontSize).toBe("18px");
      expect(getComputedStyle(heading).fontWeight).toBe("600");
    }
    expect(headings[0]?.parentElement?.parentElement?.classList.contains("gap-8")).toBe(true);
    expect(Array.from(document.querySelectorAll("h3"), (heading) => heading.textContent)).toEqual([
      "Total tokens",
      "Top provider",
      "Top model",
      "Streak",
      "Over time",
      "Token mix",
      "Providers",
      "Models",
      "Claude",
      "Codex",
      "Cursor",
    ]);
    for (const heading of document.querySelectorAll("h3")) {
      expect(heading.closest('[data-slot="card"]')).not.toBeNull();
      expect(getComputedStyle(heading).fontSize).toBe("14px");
      expect(getComputedStyle(heading).fontWeight).toBe("500");
    }
    const limits = page.getByRole("region", { name: "Subscription limits", exact: true }).element();
    const disclaimer = Array.from(document.querySelectorAll("p")).find((paragraph) =>
      paragraph.textContent?.startsWith("*Token"),
    );
    expect(disclaimer).toBeDefined();
    expect(
      limits.compareDocumentPosition(disclaimer!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getUsageSummary).toHaveBeenCalledWith({ range: "7d" });
    await page.getByRole("button", { name: "30d", exact: true }).click();
    await expect.poll(() => getUsageSummary.mock.calls.at(-1)?.[0]).toEqual({ range: "30d" });
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { level: 3, name: "Providers", exact: true }))
      .toBeInTheDocument();
  });

  it("retains the same main hierarchy for empty usage and hides unsupported limits", async () => {
    getUsageSummary.mockResolvedValue({
      ...summary,
      totals: { ...totals, usedTokens: 0 },
      buckets: [],
      providers: [],
      models: [],
    });
    state.providers = state.providers.map((provider) =>
      Object.assign({}, provider, {
        usageLimits: { ...provider.usageLimits!, status: "unavailable" as const },
      }),
    );
    mounted = await render(<UsagePage />);
    await expect
      .element(page.getByRole("heading", { level: 2, name: "Token usage" }))
      .toBeInTheDocument();
    expect(Array.from(document.querySelectorAll("h2"), (heading) => heading.textContent)).toEqual([
      "Overview",
      "Token usage",
      "Breakdown",
    ]);
    await expect.element(page.getByText("No usage yet.").first()).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { level: 3, name: "Providers", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { level: 3, name: "Models", exact: true }))
      .toBeInTheDocument();
  });
});
