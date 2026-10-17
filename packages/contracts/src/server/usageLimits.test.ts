import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerProviderUsageLimits } from "./usageLimits";

const available = {
  status: "available",
  source: "claude-agent-sdk",
  checkedAt: "2026-09-06T12:00:00.000Z",
  lastSuccessfulAt: "2026-09-06T12:00:00.000Z",
  subscriptionType: "max",
  windows: [
    {
      id: "five_hour",
      kind: "five-hour",
      label: "5-hour limit",
      utilization: 42,
      resetAt: "2026-09-06T15:00:00.000Z",
    },
  ],
  extraUsage: {
    enabled: true,
    monthlyLimit: 100,
    usedCredits: 12.5,
    utilization: 12.5,
    currency: "USD",
  },
} as const;

describe("ServerProviderUsageLimits", () => {
  it.each(["codex-app-server", "cursor-dashboard", "opencode-go-api"])(
    "decodes %s without exposing raw credentials",
    (source) => {
      const decoded = Schema.decodeUnknownSync(ServerProviderUsageLimits)({
        ...available,
        source,
        windows: [
          { ...available.windows[0], kind: source === "codex-app-server" ? "rolling" : "monthly" },
        ],
        accessToken: "private-session",
        headers: { Authorization: "private-key" },
      });
      expect(decoded.source).toBe(source);
      expect(decoded).not.toHaveProperty("accessToken");
      expect(decoded).not.toHaveProperty("headers");
    },
  );
  it("decodes a normalized available snapshot", () => {
    expect(Schema.decodeUnknownSync(ServerProviderUsageLimits)(available)).toEqual(available);
  });

  it.each([-1, 101, Number.NaN])("rejects invalid utilization %s", (utilization) => {
    expect(() =>
      Schema.decodeUnknownSync(ServerProviderUsageLimits)({
        ...available,
        windows: [{ ...available.windows[0], utilization }],
      }),
    ).toThrow();
  });

  it("keeps pending snapshots free of raw SDK data", () => {
    const pending = Schema.decodeUnknownSync(ServerProviderUsageLimits)({
      status: "pending",
      source: "claude-agent-sdk",
      checkedAt: "2026-09-06T12:00:00.000Z",
      windows: [],
      session: { secret: "not exposed" },
    });

    expect(pending).toEqual({
      status: "pending",
      source: "claude-agent-sdk",
      checkedAt: "2026-09-06T12:00:00.000Z",
      windows: [],
    });
  });
});
