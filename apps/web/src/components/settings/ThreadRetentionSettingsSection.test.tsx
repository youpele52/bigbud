import { THREAD_RETENTION_POLICY_LABELS } from "@bigbud/contracts/core/settings.threadRetention";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({
  threadRetentionPolicy: "never" as const,
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => mockSettings,
}));

vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

vi.mock("../../rpc/serverState", () => ({
  applySettingsUpdated: vi.fn(),
}));

import { ThreadRetentionSettingsSection } from "./ThreadRetentionSettingsSection";
import { ThreadRetentionConfirmationContent } from "./ThreadRetentionConfirmationContent";
import { ThreadRetentionRunStatus } from "./ThreadRetentionRunStatus";
import { SETTINGS_SEARCH_ITEMS } from "./SettingsSidebarNav.items";

describe("ThreadRetentionSettingsSection", () => {
  it("renders the safe policy and explicit permanent-delete action", () => {
    const markup = renderToStaticMarkup(<ThreadRetentionSettingsSection />);

    expect(markup).toContain("Automatic thread cleanup");
    expect(markup).toContain("Automatically delete old threads");
    expect(markup).toContain("Checks thresholds daily");
    expect(markup).toContain("queue automatically");
    expect(markup).toContain("Never");
    expect(markup).toContain("Delete eligible threads now");
    expect(markup).toContain("cannot be undone");
  });

  it("uses day-based labels for every cleanup threshold", () => {
    expect(THREAD_RETENTION_POLICY_LABELS).toEqual({
      "7-days": "7 days",
      "14-days": "14 days",
      "30-days": "30 days",
      "90-days": "90 days",
      never: "Never",
    });
  });

  it("registers retention settings search entries", () => {
    expect(SETTINGS_SEARCH_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Automatic thread cleanup",
          to: "/settings/general",
        }),
        expect.objectContaining({
          label: "Automatically delete old threads",
          to: "/settings/general",
        }),
        expect.objectContaining({
          label: "Delete eligible threads now",
          to: "/settings/general",
        }),
      ]),
    );
  });

  it("states partial estimates, warnings, exclusions, and every preserved category truthfully", () => {
    const markup = renderToStaticMarkup(
      <ThreadRetentionConfirmationContent
        trigger="manual"
        preview={{
          generatedAt: "2026-08-04T00:00:00.000Z",
          policy: "7-days",
          cutoffAt: "2026-07-28T00:00:00.000Z",
          eligibleCount: 3,
          oldestEligibleActivityAt: null,
          newestEligibleActivityAt: null,
          exclusionCounts: [{ reason: "waiting_for_input", count: 2 }],
          estimatedAttachmentCount: 4,
          estimatedResourceCount: 5,
          estimatedKnownBytes: 1_024,
          attachmentEstimateComplete: false,
          resourceEstimateComplete: false,
          bytesEstimateComplete: false,
          maintenanceState: "deferred",
          warnings: ["Some managed logs could not be measured."],
          challenge: {
            token: "challenge-1",
            trigger: "manual",
            policy: "7-days",
            cutoffAt: "2026-07-28T00:00:00.000Z",
            expiresAt: "2026-08-04T00:05:00.000Z",
            singleUse: true,
          },
        }}
      />,
    );

    expect(markup).toContain("At least");
    expect(markup).toContain("bounded preview is partial");
    expect(markup).toContain("waiting for input");
    expect(markup).toContain("Some managed logs could not be measured.");
    expect(markup).toContain("confirm this request now");
    expect(markup).toContain("queue");
    for (const phrase of [
      "Pinned threads",
      "active or running threads",
      "queued threads",
      "waiting for approval or input",
      "watched threads",
      "delegated parent or child threads",
      "Project folders",
      "user-created files",
    ]) {
      expect(markup).toContain(phrase);
    }
  });

  it("shows the eligible count and backup warning before enabling finite retention", () => {
    const markup = renderToStaticMarkup(
      <ThreadRetentionConfirmationContent
        trigger="policy-change"
        preview={{
          generatedAt: "2026-08-04T00:00:00.000Z",
          policy: "7-days",
          cutoffAt: "2026-07-28T00:00:00.000Z",
          eligibleCount: 3,
          oldestEligibleActivityAt: null,
          newestEligibleActivityAt: null,
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
            token: "challenge-policy",
            trigger: "policy-change",
            policy: "7-days",
            cutoffAt: "2026-07-28T00:00:00.000Z",
            expiresAt: "2026-08-04T00:05:00.000Z",
            singleUse: true,
          },
        }}
      />,
    );

    expect(markup).toContain("3");
    expect(markup).toContain("currently eligible for future cleanup");
    expect(markup).toContain("Export or back up anything you need");
  });

  it("shows accepted and all run progress counts with a non-color status", () => {
    const markup = renderToStaticMarkup(
      <ThreadRetentionRunStatus
        pollingError={null}
        onRetry={() => undefined}
        run={{
          runId: "run-1",
          trigger: "manual",
          policy: "7-days",
          cutoffAt: "2026-07-28T00:00:00.000Z",
          status: "completed_with_failures",
          eligibleCount: 7,
          selectedCount: 6,
          requestedCount: 5,
          completedCount: 4,
          skippedCount: 1,
          failedCount: 1,
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:01:00.000Z",
          completedAt: "2026-08-04T00:01:00.000Z",
          deferredReason: null,
          errorMessage: "One thread could not be deleted.",
        }}
      />,
    );

    for (const label of [
      "Accepted:",
      "Eligible:",
      "Selected:",
      "Requested:",
      "Completed:",
      "Skipped:",
      "Failed:",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("completed with failures");
    expect(markup).toContain("One thread could not be deleted.");
  });
});
