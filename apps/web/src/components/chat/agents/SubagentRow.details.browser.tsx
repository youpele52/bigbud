import "../../../index.css";

import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SubagentRowDetails } from "./SubagentRow.details";

const agent = (overrides: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id: RuntimeTaskId.makeUnsafe("agent"),
  kind: "providerSubagent",
  nativeId: "agent",
  activityFresh: true,
  status: "inProgress",
  subject: "Debug side chat reopen bug",
  subagentType: "systematic-debugging-assistant",
  description: "Find why the side chat reopens",
  source: "observed",
  freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
  createdAt: "2026-10-16T08:00:00.000Z",
  updatedAt: "2026-10-16T08:00:10.000Z",
  ...overrides,
});

const longPrompt = "Work directly in this checkout and preserve unrelated user changes. "
  .repeat(20)
  .trim();
const sectionLabels = () =>
  [...document.querySelectorAll("section[aria-label]")].map((s) => s.getAttribute("aria-label"));

describe("SubagentRowDetails", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("groups every field into labelled sections in a stable order", async () => {
    await page.viewport(768, 800);
    await render(
      <SubagentRowDetails
        id="details"
        parentLabel="implementer"
        agent={agent({
          status: "failed",
          activityFresh: false,
          prompt: "Short prompt",
          resultSummary: "Found 2 of 3 fixtures",
          terminalReason: "Timed out",
          metrics: { totalTokens: 81_000, toolUses: 29, durationMs: 220_000 },
          recentSteps: [
            {
              id: "1",
              toolName: "Bash",
              label: "Bash: sleep 20",
              status: "completed",
              at: "2026-10-16T08:00Z",
            },
            {
              id: "2",
              toolName: "Read",
              label: "apps/web/src/index.css",
              status: "failed",
              at: "2026-10-16T08:01Z",
            },
          ],
        })}
      />,
    );
    expect(sectionLabels()).toEqual(["Task", "Outcome", "Prompt", "Recent steps · 2 of 29"]);
    const text = document.body.textContent ?? "";
    for (const value of [
      "Debug side chat reopen bug",
      "Find why the side chat reopens",
      "Type systematic-debugging-assistant",
      "Parent implementer",
      "81k tokens · 29 tools · 3m 40s",
      "Result: Found 2 of 3 fixtures",
      "Failure: Timed out",
      "Short prompt",
    ]) {
      expect(text).toContain(value);
    }
    // The repeated tool prefix is dropped; the full label stays available as the title.
    await expect
      .element(page.getByText("sleep 20", { exact: true }))
      .toHaveAttribute("title", "sleep 20");
    expect(text).not.toContain("Bash: sleep 20");
    await expect.element(page.getByText("failed", { exact: true })).toHaveClass(/text-red-600/);
    // Short prompts have nothing hidden, so no toggle.
    expect(page.getByRole("button", { name: "Show full prompt" }).query()).toBeNull();
    // Commands line up in one column across steps.
    const commands = [
      ...document.querySelectorAll<HTMLElement>("[aria-label='Recent steps'] li"),
    ].map((li) => li.children[2]!.getBoundingClientRect().left);
    expect(new Set(commands).size).toBe(1);
  });

  it("clamps a long prompt to two lines and expands it in place", async () => {
    await page.viewport(768, 800);
    await render(<SubagentRowDetails id="details" agent={agent({ prompt: longPrompt })} />);
    const prompt = page.getByText(longPrompt);
    await expect.element(prompt).toHaveClass(/line-clamp-2/);
    await page.getByRole("button", { name: "Show full prompt" }).click();
    await expect.element(prompt).not.toHaveClass(/line-clamp-2/);
    await page.getByRole("button", { name: "Hide full prompt" }).click();
    await expect.element(prompt).toHaveClass(/line-clamp-2/);
  });
});
