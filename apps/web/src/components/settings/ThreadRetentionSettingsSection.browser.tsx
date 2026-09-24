import "../../index.css";

import { Toast } from "@base-ui/react/toast";
import type { ServerThreadRetentionRun } from "@bigbud/contracts/server/threadRetention";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), start: vi.fn(), get: vi.fn(), list: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({
    threadRetentionPolicy: "never",
    defaultThreadEnvMode: "local",
    confirmThreadArchive: false,
    confirmThreadDelete: true,
  }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: {
      previewThreadRetention: mocks.preview,
      startThreadRetention: mocks.start,
      getThreadRetentionRun: mocks.get,
      listThreadRetentionRuns: mocks.list,
    },
  }),
}));
vi.mock("../../rpc/serverState", () => ({ applySettingsUpdated: vi.fn() }));

import { toastManager } from "../ui/toast.manager";
import { ThreadRetentionSettingsSection } from "./ThreadRetentionSettingsSection";
import { publishRunToast } from "./ThreadRetentionSettingsSection.progress";

function ToastStatus() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <output key={toast.id} data-testid="cleanup-toast" data-severity={toast.type}>
      {toast.title}
    </output>
  ));
}

const run: ServerThreadRetentionRun = {
  runId: "manual-browser-run",
  trigger: "manual",
  policy: "7-days",
  selectionMode: "per-thread",
  ageCriterion: "last-conversation-activity",
  cutoffAt: "2026-07-28T00:00:00.000Z",
  status: "queued",
  eligibleCount: 3,
  selectedCount: 0,
  requestedCount: 0,
  completedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  removableResourceCount: 0,
  completedResourceCount: 0,
  retainedResourceCount: 0,
  blockedResourceCount: 0,
  canonicalPendingCount: 0,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
  completedAt: null,
  deferredReason: null,
  errorMessage: null,
};

describe("Settings manual thread cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.list.mockResolvedValue({
      runs: [],
      availability: "available",
      policySelectionMode: "legacy-subtree",
      policyAgeCriterion: "last-conversation-activity",
    });
    mocks.get.mockResolvedValue(run);
    mocks.start.mockResolvedValue(run);
    mocks.preview.mockResolvedValue({
      generatedAt: run.createdAt,
      policy: run.policy,
      selectionMode: "per-thread",
      ageCriterion: "last-conversation-activity",
      cutoffAt: run.cutoffAt,
      eligibleCount: 3,
      oldestEligibleAgeAt: null,
      newestEligibleAgeAt: null,
      exclusionCounts: [],
      estimatedAttachmentCount: 0,
      estimatedResourceCount: 0,
      estimatedKnownBytes: 0,
      attachmentEstimateComplete: true,
      resourceEstimateComplete: true,
      bytesEstimateComplete: true,
      maintenanceState: "available",
      warnings: [],
      challenge: {
        token: "cleanup-challenge",
        trigger: "manual",
        policy: run.policy,
        selectionMode: "per-thread",
        ageCriterion: "last-conversation-activity",
        cutoffAt: run.cutoffAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        singleUse: true,
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts promptly and updates one run toast when persisted progress finishes", async () => {
    const screen = await render(
      <Toast.Provider toastManager={toastManager} timeout={0}>
        <ThreadRetentionSettingsSection />
        <ToastStatus />
      </Toast.Provider>,
    );
    try {
      await page.getByRole("button", { name: "Delete now", exact: true }).click();
      await expect
        .element(
          page.getByRole("combobox", {
            name: "One-off cleanup age rule",
          }),
        )
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Delete eligible threads", exact: true }).click();
      expect(mocks.start).toHaveBeenCalledExactlyOnceWith({ challengeToken: "cleanup-challenge" });
      await expect
        .element(page.getByTestId("cleanup-toast").last())
        .toHaveAttribute("data-severity", "loading");
      mocks.get.mockResolvedValue({
        ...run,
        status: "completed",
        selectedCount: 3,
        requestedCount: 3,
        completedCount: 3,
        updatedAt: "2026-08-04T00:02:00.000Z",
        completedAt: "2026-08-04T00:02:00.000Z",
      });
      await expect
        .element(page.getByTestId("cleanup-toast").last())
        .toHaveTextContent("Cleanup finished: 3 threads deleted.");
      await expect
        .element(page.getByTestId("cleanup-toast").last())
        .toHaveAttribute("data-severity", "success");
      expect(window.localStorage.getItem("bigbud.manualThreadRetentionRunId")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("rehydrates a manual run and reports a connection gap without a failure toast", async () => {
    const rehydratedRun = { ...run, runId: "rehydrated-browser-run" };
    window.localStorage.setItem("bigbud.manualThreadRetentionRunId", rehydratedRun.runId);
    mocks.get.mockRejectedValueOnce(new Error("socket lost")).mockResolvedValue(rehydratedRun);
    const screen = await render(
      <Toast.Provider toastManager={toastManager} timeout={0}>
        <ThreadRetentionSettingsSection />
        <ToastStatus />
      </Toast.Provider>,
    );
    try {
      await expect
        .element(page.getByTestId("cleanup-toast").last())
        .toHaveTextContent("Cleanup: reconnecting for progress…");
      await expect
        .element(page.getByTestId("cleanup-toast").last())
        .toHaveAttribute("data-severity", "loading");
      await expect
        .element(page.getByTestId("cleanup-toast").last())
        .toHaveTextContent("Cleanup: 0/3 deleted · 0 outcomes, 0 resources pending.");
      expect(mocks.start).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("rehydrates the same run across remounts with one accessible progress status", async () => {
    const rehydratedRun = { ...run, runId: "remount-browser-run" };
    window.localStorage.setItem("bigbud.manualThreadRetentionRunId", rehydratedRun.runId);
    mocks.get.mockResolvedValue(rehydratedRun);
    const mount = () =>
      render(
        <Toast.Provider toastManager={toastManager} timeout={0}>
          <ThreadRetentionSettingsSection />
          <ToastStatus />
        </Toast.Provider>,
      );
    const first = await mount();
    await expect.element(page.getByRole("status").last()).toBeInTheDocument();
    await first.unmount();
    const second = await mount();
    try {
      await expect
        .element(page.getByTestId("cleanup-toast"))
        .toHaveAttribute("data-severity", "loading");
      expect(document.querySelectorAll('[data-testid="cleanup-toast"]')).toHaveLength(1);
      expect(mocks.start).not.toHaveBeenCalled();
    } finally {
      await second.unmount();
    }
  });

  it("updates one accessible toast at the five-minute heartbeat without a count change", async () => {
    const heartbeatRun = { ...run, runId: "heartbeat-browser-run" };
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const update = vi.spyOn(toastManager, "update");
    const screen = await render(
      <Toast.Provider toastManager={toastManager} timeout={0}>
        <ToastStatus />
      </Toast.Provider>,
    );
    try {
      publishRunToast(heartbeatRun, true);
      await expect.element(page.getByRole("status").last()).toBeInTheDocument();
      publishRunToast(heartbeatRun);
      expect(update).not.toHaveBeenCalled();
      now.mockReturnValue(1_000 + 5 * 60_000);
      publishRunToast(heartbeatRun);
      expect(update).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll('[data-testid="cleanup-toast"]')).toHaveLength(1);
    } finally {
      now.mockRestore();
      update.mockRestore();
      await screen.unmount();
    }
  });
});
