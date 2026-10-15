import { expect, it } from "vitest";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import {
  OPENCODE_RETAINED_HISTORY_ADVISORY,
  OPENCODE_UNQUALIFIED_RUNTIME_WARNING,
} from "@bigbud/shared/opencodeAdvisory";
import { withoutVerifiedRuntimeNotice } from "./ProviderStatusBanner.qualification";
import { withoutDismissedRetainedHistoryAdvisory } from "./ProviderStatusBanner.advisory";

const connected = "Connected to your native OpenCode service.";
const status: ServerProvider = {
  provider: "opencodeV2",
  enabled: true,
  installed: true,
  version: "2.0.28",
  status: "warning",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-14T12:00:00Z",
  initialProbeComplete: true,
  models: [],
  slashCommands: [],
  skills: [],
  message: `${connected} ${OPENCODE_UNQUALIFIED_RUNTIME_WARNING}`,
};

it("clears only the exact notice after verification, without mutating settings status", () => {
  expect(withoutVerifiedRuntimeNotice(status, false)).toBe(status);
  expect(withoutVerifiedRuntimeNotice(status, true)).toBeNull();
  expect(status.message).toContain(OPENCODE_UNQUALIFIED_RUNTIME_WARNING);
  expect(status.status).toBe("warning");
});

it("retained-history dismissal remains independent of runtime verification", () => {
  const combined = {
    ...status,
    message: `${status.message} ${OPENCODE_RETAINED_HISTORY_ADVISORY}`,
  };
  const verified = withoutVerifiedRuntimeNotice(combined, true);
  expect(verified?.message).toBe(`${connected} ${OPENCODE_RETAINED_HISTORY_ADVISORY}`);
  expect(withoutDismissedRetainedHistoryAdvisory(verified, false)).toBe(verified);
  expect(withoutDismissedRetainedHistoryAdvisory(verified, true)).toBeNull();
});

it.each<Partial<ServerProvider>>([
  { status: "error" },
  { enabled: false },
  { installed: false },
  { initialProbeComplete: false },
  { auth: { status: "unauthenticated" } },
  { provider: "opencode" },
  { message: `Bridge failed. ${OPENCODE_UNQUALIFIED_RUNTIME_WARNING}` },
  { message: `${status.message} Another failure.` },
])("preserves failure and unrelated status: %j", (change) => {
  const value = { ...status, ...change };
  expect(withoutVerifiedRuntimeNotice(value, true)).toBe(value);
});
