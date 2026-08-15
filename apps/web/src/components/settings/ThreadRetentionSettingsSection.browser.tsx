import "../../index.css";

import { DEFAULT_SERVER_SETTINGS, type NativeApi, type ServerConfig } from "@bigbud/contracts";
import type {
  ServerThreadRetentionPreview,
  ServerThreadRetentionRun,
} from "@bigbud/contracts/server/threadRetention";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../rpc/nativeApi";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { ThreadRetentionSettingsSection } from "./ThreadRetentionSettingsSection";

const PREVIEW: ServerThreadRetentionPreview = {
  generatedAt: "2026-08-04T00:00:00.000Z",
  policy: "7-days",
  cutoffAt: "2026-07-28T00:00:00.000Z",
  eligibleCount: 3,
  oldestEligibleActivityAt: "2026-07-01T00:00:00.000Z",
  newestEligibleActivityAt: "2026-07-20T00:00:00.000Z",
  exclusionCounts: [{ reason: "pinned", count: 1 }],
  estimatedAttachmentCount: 2,
  estimatedResourceCount: 4,
  estimatedKnownBytes: 2_048,
  attachmentEstimateComplete: false,
  resourceEstimateComplete: false,
  bytesEstimateComplete: false,
  maintenanceState: "available",
  warnings: ["One managed log could not be measured."],
  challenge: {
    token: "challenge-1",
    trigger: "manual",
    policy: "7-days",
    cutoffAt: "2026-07-28T00:00:00.000Z",
    expiresAt: "2099-08-04T00:05:00.000Z",
    singleUse: true,
  },
};

const QUEUED_RUN: ServerThreadRetentionRun = {
  runId: "run-1",
  trigger: "manual",
  policy: "7-days",
  cutoffAt: PREVIEW.cutoffAt,
  status: "queued",
  eligibleCount: 3,
  selectedCount: 0,
  requestedCount: 0,
  completedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  createdAt: PREVIEW.generatedAt,
  updatedAt: PREVIEW.generatedAt,
  completedAt: null,
  deferredReason: null,
  errorMessage: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function configureApi(overrides: Partial<NativeApi["server"]> = {}) {
  const server = {
    listThreadRetentionRuns: vi.fn().mockResolvedValue({ runs: [], availability: "available" }),
    previewThreadRetention: vi.fn().mockResolvedValue(PREVIEW),
    getThreadRetentionRun: vi.fn().mockResolvedValue(QUEUED_RUN),
    startThreadRetention: vi.fn().mockResolvedValue(QUEUED_RUN),
    setThreadRetentionPolicy: vi.fn().mockResolvedValue(DEFAULT_SERVER_SETTINGS),
    ...overrides,
  } as unknown as NativeApi["server"];
  window.nativeApi = { server } as unknown as NativeApi;
  return server;
}

async function mountRetentionSettings(
  threadRetentionPolicy: ServerConfig["settings"]["threadRetentionPolicy"] = "never",
) {
  setServerConfigSnapshot({
    settings: { ...DEFAULT_SERVER_SETTINGS, threadRetentionPolicy },
  } as ServerConfig);
  return render(<ThreadRetentionSettingsSection />);
}

describe("ThreadRetentionSettingsSection", () => {
  beforeEach(async () => {
    await page.viewport(1_280, 800);
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    resetServerStateForTests();
    __resetNativeApiForTests();
    delete window.nativeApi;
    document.body.innerHTML = "";
  });

  it("provides semantic alert text, trapped keyboard focus, Escape, and restored focus", async () => {
    configureApi();
    const screen = await mountRetentionSettings();
    const trigger = page.getByRole("button", { name: "Delete eligible threads now" });
    await trigger.click();

    const dialog = page.getByRole("alertdialog", {
      name: "Permanently delete threads older than 7 days?",
    });
    await expect.element(dialog).toBeInTheDocument();
    await expect.element(dialog).toHaveAccessibleDescription(/3 threads have been inactive/);
    await expect.element(page.getByText("At least 4 known resources")).toBeInTheDocument();
    await expect
      .element(page.getByText("One managed log could not be measured."))
      .toBeInTheDocument();

    const cancel = page.getByRole("button", { name: "Cancel" });
    await vi.waitFor(() => expect(document.activeElement).toBe(cancel.element()));
    await userEvent.keyboard("{Tab}");
    expect(dialog.element().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Tab}");
    expect(dialog.element().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element()));
    await screen.unmount();
  });

  it("stays scroll-safe with coarse-pointer-sized controls in a mobile viewport", async () => {
    await page.viewport(390, 700);
    configureApi();
    const screen = await mountRetentionSettings();
    await page.getByRole("button", { name: "Delete eligible threads now" }).click();

    const dialog = page
      .getByRole("alertdialog", {
        name: "Permanently delete threads older than 7 days?",
      })
      .element();
    expect(dialog.getBoundingClientRect().height).toBeLessThanOrEqual(525);
    expect(getComputedStyle(dialog).overflow).toBe("hidden");
    for (const name of ["Cancel", "Delete threads permanently"]) {
      const button = page.getByRole("button", { name }).element();
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(31);
      expect(button.className).toContain("pointer-coarse:after:min-h-11");
    }
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await screen.unmount();
  });

  it("cancels stale preview responses across close and reopen races", async () => {
    const first = deferred<ServerThreadRetentionPreview>();
    const second = deferred<ServerThreadRetentionPreview>();
    configureApi({
      previewThreadRetention: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    });
    const screen = await mountRetentionSettings();
    const trigger = page.getByRole("button", { name: "Delete eligible threads now" });

    await trigger.click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await trigger.click();
    second.resolve({ ...PREVIEW, eligibleCount: 8 });
    await expect.element(page.getByText(/8 threads have been inactive/)).toBeInTheDocument();
    first.resolve({ ...PREVIEW, eligibleCount: 1 });
    await Promise.resolve();
    await expect.element(page.getByText(/8 threads have been inactive/)).toBeInTheDocument();
    await expect.element(page.getByText(/1 threads have been inactive/)).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await screen.unmount();
  });

  it("polls deferred work through completion and stops at the terminal state", async () => {
    vi.useFakeTimers();
    const deferredRun = {
      ...QUEUED_RUN,
      status: "deferred",
      deferredReason: "waiting for active work",
      updatedAt: "2026-08-04T00:00:01.000Z",
    } satisfies ServerThreadRetentionRun;
    const completedRun = {
      ...deferredRun,
      status: "completed",
      selectedCount: 3,
      requestedCount: 3,
      completedCount: 2,
      skippedCount: 1,
      completedAt: "2026-08-04T00:00:02.000Z",
      updatedAt: "2026-08-04T00:00:02.000Z",
    } satisfies ServerThreadRetentionRun;
    const getRun = vi.fn().mockResolvedValueOnce(deferredRun).mockResolvedValue(completedRun);
    configureApi({
      listThreadRetentionRuns: vi
        .fn()
        .mockResolvedValue({ runs: [QUEUED_RUN], availability: "available" }),
      getThreadRetentionRun: getRun,
    });
    const screen = await mountRetentionSettings();
    await vi.waitFor(() =>
      expect(page.getByText(/Cleanup request is ready/).element()).toBeTruthy(),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(page.getByText(/Cleanup is paused/).element()).toBeTruthy());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() =>
      expect(page.getByText(/Latest cleanup: completed/).element()).toBeTruthy(),
    );
    await page.getByRole("button", { name: /Latest cleanup: completed/ }).click();
    await expect.element(page.getByText("Completed: ")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getRun).toHaveBeenCalledTimes(2);
    await screen.unmount();
  });

  it("shows an actionable polling error, retries, and cleans up on unmount", async () => {
    vi.useFakeTimers();
    const getRun = vi
      .fn()
      .mockRejectedValue(new Error("Retention status is temporarily unavailable."));
    configureApi({
      listThreadRetentionRuns: vi
        .fn()
        .mockResolvedValue({ runs: [QUEUED_RUN], availability: "available" }),
      getThreadRetentionRun: getRun,
    });
    const screen = await mountRetentionSettings();
    await vi.waitFor(() =>
      expect(page.getByText(/Cleanup request is ready/).element()).toBeTruthy(),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(getRun).toHaveBeenCalledTimes(5);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Check the connection, then retry");

    getRun.mockResolvedValue({ ...QUEUED_RUN, status: "completed" });
    await page.getByRole("button", { name: "Retry updates" }).click();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() =>
      expect(page.getByText(/Latest cleanup: completed/).element()).toBeTruthy(),
    );
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getRun).toHaveBeenCalledTimes(6);
  });

  it("allows a manual request to be confirmed while scheduled cleanup is active", async () => {
    const scheduledPreview = { ...PREVIEW, maintenanceState: "scheduled_active" as const };
    const server = configureApi({
      listThreadRetentionRuns: vi
        .fn()
        .mockResolvedValue({ runs: [QUEUED_RUN], availability: "available" }),
      previewThreadRetention: vi.fn().mockResolvedValue(scheduledPreview),
    });
    const screen = await mountRetentionSettings();
    const trigger = page.getByRole("button", { name: "Delete eligible threads now" });

    await expect.element(trigger).toBeEnabled();
    await trigger.click();
    await expect.element(page.getByText(/starts at the next safe checkpoint/)).toBeInTheDocument();
    const confirm = page.getByRole("button", { name: "Delete threads permanently" });
    await expect.element(confirm).toBeEnabled();
    await confirm.click();

    expect(server.startThreadRetention).toHaveBeenCalledWith({ challengeToken: "challenge-1" });
    await screen.unmount();
  });

  it("uses neutral copy while another manual cleanup is active", async () => {
    const server = configureApi({
      previewThreadRetention: vi
        .fn()
        .mockResolvedValue({ ...PREVIEW, maintenanceState: "manual_active" as const }),
    });
    const screen = await mountRetentionSettings();

    await page.getByRole("button", { name: "Delete eligible threads now" }).click();
    await expect
      .element(
        page.getByText(
          "Another manual cleanup is active. This request may join an equivalent cleanup; otherwise it waits for that cleanup.",
        ),
      )
      .toBeInTheDocument();
    expect(server.previewThreadRetention).toHaveBeenCalledWith({
      trigger: "manual",
      policy: "7-days",
    });
    await screen.unmount();
  });

  it("always exposes a one-off policy selector and refreshes its preview", async () => {
    const sevenDayPreview = {
      ...PREVIEW,
      policy: "7-days" as const,
      cutoffAt: "2026-07-28T00:00:00.000Z",
      challenge: {
        ...PREVIEW.challenge,
        policy: "7-days" as const,
        cutoffAt: "2026-07-28T00:00:00.000Z",
      },
    };
    const ninetyDayPreview = {
      ...PREVIEW,
      policy: "90-days" as const,
      cutoffAt: "2026-05-06T00:00:00.000Z",
      challenge: {
        ...PREVIEW.challenge,
        policy: "90-days" as const,
        cutoffAt: "2026-05-06T00:00:00.000Z",
      },
    };
    const server = configureApi({
      previewThreadRetention: vi
        .fn()
        .mockResolvedValueOnce(sevenDayPreview)
        .mockResolvedValueOnce(ninetyDayPreview),
    });
    const screen = await mountRetentionSettings();

    await page.getByRole("button", { name: "Delete eligible threads now" }).click();
    await expect
      .element(page.getByRole("combobox", { name: "One-off cleanup period" }))
      .toBeInTheDocument();
    expect(server.previewThreadRetention).toHaveBeenCalledWith({
      trigger: "manual",
      policy: "7-days",
    });
    await expect
      .element(
        page.getByRole("alertdialog", { name: "Permanently delete threads older than 7 days?" }),
      )
      .toBeInTheDocument();

    await page.getByRole("combobox", { name: "One-off cleanup period" }).click();
    for (const label of ["1 day", "2 days", "3 days"]) {
      await expect.element(page.getByRole("option", { name: label })).toBeInTheDocument();
    }
    await page.getByRole("option", { name: "90 days" }).click();
    await expect
      .element(
        page.getByRole("alertdialog", { name: "Permanently delete threads older than 90 days?" }),
      )
      .toBeInTheDocument();
    expect(server.previewThreadRetention).toHaveBeenLastCalledWith({
      trigger: "manual",
      policy: "90-days",
    });
    await screen.unmount();
  });
});
