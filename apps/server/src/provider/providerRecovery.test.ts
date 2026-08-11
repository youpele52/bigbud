import type { ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  isProviderRetryable,
  isProviderStartupRetryable,
  needsProviderRefresh,
} from "./providerRecovery";

const provider = (overrides: Partial<ServerProvider>): ServerProvider => ({
  provider: "codex",
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-08-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("provider recovery", () => {
  it("retries missing binaries and transient provider errors", () => {
    expect(
      isProviderRetryable(
        provider({ failure: { classification: "retryable", reason: "startup-timeout" } }),
      ),
    ).toBe(true);
    expect(
      isProviderStartupRetryable(
        provider({
          installed: false,
          failure: { classification: "user-action-required", reason: "command-not-found" },
        }),
      ),
    ).toBe(true);
  });

  it("does not repeat checks that require user action", () => {
    expect(
      isProviderRetryable(
        provider({
          failure: { classification: "user-action-required", reason: "authentication-required" },
        }),
      ),
    ).toBe(false);
    expect(
      isProviderRetryable(
        provider({
          failure: { classification: "user-action-required", reason: "unsupported-version" },
        }),
      ),
    ).toBe(false);
  });

  it("still includes user-action failures in the first manual refresh", () => {
    expect(
      needsProviderRefresh(
        provider({
          failure: { classification: "user-action-required", reason: "configuration-required" },
        }),
      ),
    ).toBe(true);
  });
});
