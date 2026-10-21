import "../../../index.css";

import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SubagentsCard } from "./SubagentsCard";

const agent = (id: string, overrides: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id: RuntimeTaskId.makeUnsafe(id),
  kind: "providerSubagent",
  nativeId: id,
  activityFresh: true,
  status: "inProgress",
  subject: `Subject ${id}`,
  source: "observed",
  freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
  createdAt: "2026-10-16T08:00:00.000Z",
  updatedAt: "2026-10-16T08:00:10.000Z",
  ...overrides,
});

const longText = "Investigate the provider subagent pipeline end to end ".repeat(12);

const agents: OrchestrationTask[] = [
  agent("root", {
    subagentType: "general-purpose-research-agent-with-a-long-name",
    model: "claude-sonnet-4-5-20250929-with-a-very-long-model-identifier",
    effort: "high",
    prompt: longText,
    progressSummary: longText,
    metrics: { totalTokens: 48_200, toolUses: 12, durationMs: 95_000, costUsd: 0.42 },
    recentSteps: [
      { id: "s1", toolName: "Read", label: longText, status: "completed", at: "2026-10-16T08:00Z" },
      {
        id: "s2",
        toolName: "Bash",
        label: "bun run test",
        status: "running",
        at: "2026-10-16T08:01Z",
      },
    ],
  }),
  agent("child", { parentTaskId: RuntimeTaskId.makeUnsafe("root"), lastToolName: "Grep" }),
  agent("done", {
    status: "completed",
    resultSummary: "Found the regression in the reducer",
    endedAt: "2026-10-16T08:00:42.000Z",
  }),
  agent("failed", { status: "failed", terminalReason: "Tool permission denied" }),
  agent("stale", { activityFresh: false }),
];

async function renderCard(width: number) {
  await page.viewport(width, 800);
  await render(<SubagentsCard agents={agents} nowIso="2026-10-16T08:02:05.000Z" />);
  await page.getByRole("button", { name: /Show 4 more/ }).click();
}

describe("SubagentsCard", () => {
  afterEach(async () => {
    await page.viewport(1280, 800);
    document.body.innerHTML = "";
  });

  for (const width of [375, 1280]) {
    it(`shows status, model, elapsed time and details without overflow at ${width}px`, async () => {
      await renderCard(width);
      await expect
        .element(page.getByText("Working", { exact: true }).first())
        .toHaveClass(/text-blue-600/);
      await expect.element(page.getByText("Done", { exact: true })).toHaveClass(/text-emerald-600/);
      await expect.element(page.getByText("Failed", { exact: true })).toHaveClass(/text-red-600/);
      await expect
        .element(page.getByText("Last seen", { exact: true }))
        .toHaveClass(/text-amber-600/);
      await expect
        .element(page.getByTitle(/claude-sonnet-4-5-20250929/))
        .toHaveTextContent(/· high$/);
      // Live elapsed time follows the shared clock; terminal rows freeze at endedAt.
      expect(document.body.textContent).toContain("· 2m");
      expect(document.body.textContent).toContain("· 42s");
      expect(document.body.textContent).toContain("Running Grep");

      await page.getByRole("button", { name: /general-purpose-research-agent/ }).click();
      await expect.element(page.getByRole("list", { name: "Recent steps" })).toBeVisible();
      expect(document.body.textContent).toContain("48k tokens · 12 tools · 1m 35s · $0.42");

      const card = document.querySelector<HTMLElement>('section[aria-label="Subagents"]');
      expect(card).not.toBeNull();
      expect(card!.scrollWidth).toBeLessThanOrEqual(card!.clientWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    });
  }

  it("nests a child under its parent task with indentation", async () => {
    await renderCard(1280);
    const child = document.querySelector<HTMLElement>('[data-subagent-row="child"]');
    expect(child?.getAttribute("aria-label")).toContain("child of Subject root");
    expect(child?.style.paddingLeft).toBe("18px");
  });

  it("shows the assignment and background mode before any progress, without expanding", async () => {
    await page.viewport(375, 800);
    await render(
      <SubagentsCard
        agents={[
          agent("review", {
            subagentType: "systematic-debugging-assistant",
            description: "Diagnose restart and coexistence failures",
            background: true,
          }),
        ]}
      />,
    );
    await expect.element(page.getByText("Background", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Diagnose restart and coexistence failures", { exact: true }))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
