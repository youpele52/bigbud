import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), toast: vi.fn() }));
vi.mock("../../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: mocks.dispatch } }),
}));
vi.mock("../../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../messages/ThreadOriginLink", () => ({
  ThreadOriginLink: (props: { title: string }) => <span>{props.title}</span>,
}));

import type { DelegatedChildSummary } from "../../../models/types/app.types";
import {
  makeRequestedPayload,
  makeResolvedPayload,
} from "../view/ThreadModelChoiceNotice.test.helpers";
import { DelegatedChildrenCard } from "./DelegatedChildrenCard";

const child = (
  id: string,
  modelChoice?: DelegatedChildSummary["modelChoice"],
): DelegatedChildSummary => ({
  threadId: id as never,
  title: `Child ${id}`,
  projectId: null,
  workflowState: "idle",
  updatedAt: "2026-10-15T10:00:00.000Z",
  ...(modelChoice !== undefined ? { modelChoice } : {}),
});

describe("DelegatedChildrenCard model choice (OD3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatch.mockResolvedValue({ sequence: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("opens the same picker from a pending row and picks for the child", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    await render(
      <DelegatedChildrenCard
        items={[
          child("child-pending", {
            source: "tributary",
            record: { status: "pending", ...makeRequestedPayload({ choiceId: "card-choice" }) },
          }),
        ]}
      />,
    );
    const trigger = page.getByRole("button", { name: "Choose model · 10s" });
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    for (let seconds = 9; seconds >= 8; seconds -= 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(`Choose model · ${seconds}s`),
      );
    }
    vi.useRealTimers();

    await page.getByRole("button", { name: /Choose model/ }).click();
    await expect.element(page.getByRole("group", { name: "Available models" })).toBeVisible();
    await page.getByRole("button", { name: /Claude Sonnet/ }).click();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.delegation.model-choice.pick",
        threadId: "child-pending",
        choiceId: "card-choice",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
      }),
    );
  });

  it("shows the resolved model per child, green or amber, and the request after a reload", async () => {
    await render(
      <DelegatedChildrenCard
        items={[
          child("child-picked", {
            source: "tributary",
            record: {
              ...makeResolvedPayload({
                used: { provider: "claudeAgent", model: "claude-sonnet" },
                outcome: "user-picked",
                resolvedBy: "user",
              }),
              status: "resolved",
              cancelled: false,
            },
          }),
          child("child-fallback", {
            source: "tributary",
            record: { ...makeResolvedPayload(), status: "resolved", cancelled: false },
          }),
          child("child-linked", {
            source: "linked",
            summary: { requested: { provider: "cursor", model: "composer-1" }, status: "pending" },
          }),
          child("child-plain"),
        ]}
      />,
    );
    const picked = page.getByText("claude-sonnet", { exact: true });
    await expect.element(picked).toHaveClass(/text-success/);
    await expect
      .element(picked)
      .toHaveAttribute("title", "You chose claude-sonnet (requested composer-1 unavailable)");
    await expect.element(page.getByText("gpt-5", { exact: true })).toHaveClass(/text-warning/);
    await expect.element(page.getByText("Requested composer-1")).toBeVisible();
    expect(page.getByRole("button").elements()).toHaveLength(0);
  });
});
