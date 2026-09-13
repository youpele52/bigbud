import "../../index.css";

import { Toast } from "@base-ui/react/toast";
import type { ServerThreadRetentionResult } from "@bigbud/contracts/server/threadRetention";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), start: vi.fn() }));
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
    server: { previewThreadRetention: mocks.preview, startThreadRetention: mocks.start },
  }),
}));
vi.mock("../../rpc/serverState", () => ({ applySettingsUpdated: vi.fn() }));

import { toastManager } from "../ui/toast.manager";
import { ThreadRetentionSettingsSection } from "./ThreadRetentionSettingsSection";

// Observe the real provider's toast lifecycle and severity without depending on animation.
function ToastStatus() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <output key={toast.id} data-testid="cleanup-toast" data-severity={toast.type}>
      {toast.title} {toast.description}
    </output>
  ));
}

const result = {
  trigger: "manual",
  policy: "7-days",
  cutoffAt: "2026-07-28T00:00:00.000Z",
  eligibleCount: 3,
  deletedCount: 3,
  skippedCount: 0,
  pendingCount: 0,
  completedAt: "2026-08-04T00:00:00.000Z",
} satisfies ServerThreadRetentionResult;

describe("Settings manual thread cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preview.mockResolvedValue({
      generatedAt: result.completedAt,
      policy: result.policy,
      cutoffAt: result.cutoffAt,
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
        token: "cleanup-challenge",
        trigger: "manual",
        policy: result.policy,
        cutoffAt: result.cutoffAt,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        singleUse: true,
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(["success", "failure", "unconfirmed"] as const)(
    "handles asynchronous cleanup %s and restores the controls",
    async (outcome) => {
      let resolveCleanup!: (value: ServerThreadRetentionResult) => void;
      let rejectCleanup!: (error: Error) => void;
      mocks.start.mockReturnValue(
        new Promise<ServerThreadRetentionResult>((resolve, reject) => {
          resolveCleanup = resolve;
          rejectCleanup = reject;
        }),
      );
      const screen = await render(
        <Toast.Provider toastManager={toastManager} timeout={0}>
          <ThreadRetentionSettingsSection />
          <ToastStatus />
        </Toast.Provider>,
      );
      try {
        await page.getByRole("button", { name: "Delete now", exact: true }).click();
        await page.getByRole("button", { name: "Delete eligible threads", exact: true }).click();
        expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
          challengeToken: "cleanup-challenge",
        });
        await expect
          .element(page.getByTestId("cleanup-toast"))
          .toHaveAttribute("data-severity", "loading");
        await expect
          .element(page.getByRole("button", { name: "Delete now", exact: true }))
          .toBeDisabled();
        if (outcome === "failure") {
          rejectCleanup(new Error("Failed to run thread retention."));
          await expect
            .element(page.getByTestId("cleanup-toast"))
            .toHaveTextContent("Unable to confirm thread cleanup Failed to run thread retention.");
          await expect
            .element(page.getByTestId("cleanup-toast"))
            .toHaveAttribute("data-severity", "error");
          await expect.element(page.getByText(/Latest cleanup:/)).not.toBeInTheDocument();
        } else if (outcome === "unconfirmed") {
          resolveCleanup({ ...result, deletedCount: 1, pendingCount: 2 });
          await expect
            .element(page.getByTestId("cleanup-toast"))
            .toHaveTextContent(
              "Thread cleanup needs attention Deleted 1 threads and skipped 0. 2 deletion outcomes could not be confirmed.",
            );
          await expect
            .element(page.getByTestId("cleanup-toast"))
            .toHaveAttribute("data-severity", "warning");
          await expect
            .element(
              page.getByText(
                "Latest cleanup: Deleted 1 threads and skipped 0. 2 deletion outcomes could not be confirmed.",
              ),
            )
            .toBeInTheDocument();
        } else {
          resolveCleanup(result);
          await expect
            .element(page.getByTestId("cleanup-toast"))
            .toHaveTextContent("Thread cleanup finished Deleted 3 threads and skipped 0.");
          await expect
            .element(page.getByTestId("cleanup-toast"))
            .toHaveAttribute("data-severity", "success");
          await expect
            .element(page.getByText("Latest cleanup: Deleted 3 threads and skipped 0."))
            .toBeInTheDocument();
        }
        await expect
          .element(page.getByRole("button", { name: "Delete now", exact: true }))
          .toBeEnabled();
        await expect
          .element(page.getByRole("combobox", { name: "Automatic thread cleanup period" }))
          .toBeEnabled();
      } finally {
        await screen.unmount();
      }
    },
  );
});
