import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { OPENCODE_RETAINED_HISTORY_ADVISORY } from "@bigbud/shared/opencodeAdvisory";
import { describe, expect, it } from "vitest";
import {
  getRetainedHistoryAdvisory,
  withoutDismissedRetainedHistoryAdvisory,
} from "./ProviderStatusBanner.advisory";

const connected: ServerProvider = {
  provider: "opencodeV2",
  enabled: true,
  installed: true,
  version: "1.17.18",
  status: "warning",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-13T12:00:00.000Z",
  initialProbeComplete: true,
  models: [],
  slashCommands: [],
  skills: [],
  message: `Connected to your native OpenCode service. ${OPENCODE_RETAINED_HISTORY_ADVISORY}`,
};

describe("retained-history advisory discrimination", () => {
  it("hides only a dismissed pure advisory on a healthy connected provider", () => {
    expect(withoutDismissedRetainedHistoryAdvisory(connected, false)).toBe(connected);
    expect(withoutDismissedRetainedHistoryAdvisory(connected, true)).toBeNull();
    expect(
      withoutDismissedRetainedHistoryAdvisory(
        { ...connected, message: OPENCODE_RETAINED_HISTORY_ADVISORY },
        true,
      ),
    ).toBeNull();
    expect(withoutDismissedRetainedHistoryAdvisory(null, true)).toBeNull();
  });

  it.each([
    { status: "error" },
    { installed: false },
    { enabled: false },
    { initialProbeComplete: false },
    { auth: { status: "unauthenticated" } },
    { failure: { classification: "user-action-required", reason: "configuration-required" } },
    {
      recovery: {
        status: "retrying",
        operationId: "launch",
        generation: 1,
        attempt: 1,
        maxAttempts: 5,
        trigger: "startup",
      },
    },
  ] satisfies Partial<ServerProvider>[])("does not suppress unhealthy metadata: %j", (override) => {
    const status = { ...connected, ...override };
    expect(getRetainedHistoryAdvisory(status)?.advisoryOnly).toBe(false);
    const visible = withoutDismissedRetainedHistoryAdvisory(status, true);
    expect(visible).not.toBeNull();
    expect(visible?.status).toBe(status.status);
    expect(visible?.failure).toEqual(status.failure);
  });

  it("preserves the complete primary warning and never substring-matches unfamiliar text", () => {
    const message = "Required bridge missing; native setup is required.";
    expect(
      withoutDismissedRetainedHistoryAdvisory(
        { ...connected, message: `${message} ${OPENCODE_RETAINED_HISTORY_ADVISORY}` },
        true,
      )?.message,
    ).toBe(message);
    for (const status of [
      { ...connected, message: "Logical native history is retained. Setup failed." },
      { ...connected, message: `${OPENCODE_RETAINED_HISTORY_ADVISORY} Additional error.` },
      { ...connected, provider: "opencode" as const },
    ]) {
      expect(getRetainedHistoryAdvisory(status)).toBeNull();
      expect(withoutDismissedRetainedHistoryAdvisory(status, true)).toBe(status);
    }
  });
});
