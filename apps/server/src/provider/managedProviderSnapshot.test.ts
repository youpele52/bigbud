import type { ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { preserveEnrichedProviderSnapshot } from "./managedProviderSnapshot";

const available: ServerProvider = {
  provider: "claudeAgent",
  enabled: true,
  installed: true,
  version: "2.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-06T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    status: "available",
    source: "claude-agent-sdk",
    checkedAt: "2026-09-06T12:00:00.000Z",
    lastSuccessfulAt: "2026-09-06T12:00:00.000Z",
    windows: [{ id: "five_hour", kind: "five-hour", label: "5-hour limit", utilization: 45 }],
  },
};

const failed: ServerProvider = {
  ...available,
  checkedAt: "2026-09-06T12:05:00.000Z",
  usageLimits: {
    status: "error",
    source: "claude-agent-sdk",
    checkedAt: "2026-09-06T12:05:00.000Z",
    message: "Claude subscription limits could not be refreshed.",
    windows: [],
  },
};

describe("preserveEnrichedProviderSnapshot usage limits", () => {
  it("retains last-good values as stale after a transient quota failure", () => {
    expect(preserveEnrichedProviderSnapshot(failed, available, false).usageLimits).toEqual({
      ...available.usageLimits,
      status: "stale",
      checkedAt: "2026-09-06T12:05:00.000Z",
      message: "Claude subscription limits could not be refreshed.",
    });
  });

  it("replaces stale values after quota recovery", () => {
    const stale = preserveEnrichedProviderSnapshot(failed, available, false);
    const recovered = {
      ...available,
      checkedAt: "2026-09-06T12:10:00.000Z",
      usageLimits: {
        ...available.usageLimits!,
        checkedAt: "2026-09-06T12:10:00.000Z",
        lastSuccessfulAt: "2026-09-06T12:10:00.000Z",
        windows: [{ ...available.usageLimits!.windows[0]!, utilization: 10 }],
      },
    } satisfies ServerProvider;

    expect(preserveEnrichedProviderSnapshot(recovered, stale, false).usageLimits).toEqual(
      recovered.usageLimits,
    );
  });

  it("does not retain quota when Claude is disabled", () => {
    const disabled = {
      ...failed,
      enabled: false,
      status: "disabled" as const,
      usageLimits: { ...failed.usageLimits!, status: "unavailable" as const },
    };

    expect(preserveEnrichedProviderSnapshot(disabled, available, false).usageLimits).toEqual(
      disabled.usageLimits,
    );
  });
});
