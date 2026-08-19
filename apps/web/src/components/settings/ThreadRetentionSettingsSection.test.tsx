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
import { SETTINGS_SEARCH_ITEMS } from "./SettingsSidebarNav.items";

describe("ThreadRetentionSettingsSection", () => {
  it("renders the server-owned daily policy and immediate cleanup action", () => {
    const markup = renderToStaticMarkup(<ThreadRetentionSettingsSection />);

    expect(markup).toContain("Automatic thread cleanup");
    expect(markup).toContain("Automatically delete old threads");
    expect(markup).toContain("The server checks daily");
    expect(markup).toContain("Eligible root thread subtrees are cleaned up together");
    expect(markup).toContain("Never");
    expect(markup).toContain("Delete eligible threads now");
    expect(markup).toContain(
      "Eligible root thread subtrees and their descendants are cleaned up together",
    );
  });

  it("uses day-based labels for every cleanup threshold", () => {
    expect(THREAD_RETENTION_POLICY_LABELS).toEqual({
      "1-day": "1 day",
      "2-days": "2 days",
      "3-days": "3 days",
      "7-days": "7 days",
      "14-days": "14 days",
      "30-days": "30 days",
      "90-days": "90 days",
      never: "Never",
    });
    expect(JSON.stringify(THREAD_RETENTION_POLICY_LABELS)).toContain("1 day");
    expect(JSON.stringify(THREAD_RETENTION_POLICY_LABELS)).toContain("2 days");
    expect(JSON.stringify(THREAD_RETENTION_POLICY_LABELS)).toContain("3 days");
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
          maintenanceState: "safety_deferred",
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
    expect(markup).toContain("This is an estimate.");
    expect(markup).toContain("waiting for input");
    expect(markup).toContain("Some managed logs could not be measured.");
    for (const phrase of [
      "Child threads are deleted with their parent",
      "Pinned",
      "active or running",
      "project folders",
      "other files",
      "Provider-remote conversations are not deleted",
      "canonical history or retained baselines",
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
});
