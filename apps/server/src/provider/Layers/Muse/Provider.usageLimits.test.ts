import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import { makeMuseHostCallbacks } from "./Adapter.startSession.callbacks.ts";
import type { MuseHostFactory, MuseTransport } from "./Client.ts";
import { resolveMuseLaunch } from "./Client.platform.ts";
import { formatMuseTier, normalizeMuseUsage } from "./Provider.usageLimits.normalize.ts";
import { readMuseUsageLimits } from "./Provider.usageLimits.ts";
import { MuseUsageObservations } from "./Usage.observations.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const checkedAt = new Date(NOW).toISOString();
const settings = { enabled: true, binaryPath: "muse" };

const mspUsage = (observedAtMs: number, used = 42) => ({
  observedAtMs,
  tier: "everyday_usage",
  window: { usedPercent: used, resetsAtMs: NOW + 3_600_000, windowDurationMins: 300 },
  weekly: { usedPercent: 120, resetsAtMs: NOW + 86_400_000 },
});

function hostWith(usage: unknown) {
  let closed = 0;
  const transport = {
    request: async (method: string) => (method === "usage/read" ? usage : {}),
    close: async () => {
      closed++;
    },
  } as unknown as MuseTransport;
  const factory: MuseHostFactory = async () => transport;
  return { factory, closed: () => closed };
}

describe("normalizeMuseUsage", () => {
  it("maps the MSP window and weekly blocks, capping over-quota percentages", () => {
    const limits = normalizeMuseUsage(mspUsage(NOW), checkedAt);
    expect(limits.status).toBe("available");
    expect(limits.source).toBe("muse-msp");
    expect(limits.subscriptionType).toBe("Everyday Usage");
    expect(limits.windows).toEqual([
      {
        id: "window",
        kind: "five-hour",
        label: "5-hour limit",
        utilization: 42,
        resetAt: new Date(NOW + 3_600_000).toISOString(),
      },
      {
        id: "weekly",
        kind: "seven-day",
        label: "7-day limit",
        utilization: 100,
        resetAt: new Date(NOW + 86_400_000).toISOString(),
      },
    ]);
  });

  it("accepts the snake_case spelling and non-five-hour windows", () => {
    const limits = normalizeMuseUsage(
      { tier: "power", window: { used_percent: 10, resets_at_ms: NOW, window_duration_mins: 240 } },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      expect.objectContaining({ kind: "rolling", label: "4-hour limit", utilization: 10 }),
    ]);
    expect(formatMuseTier("  ")).toBeUndefined();
  });
});

describe("readMuseUsageLimits", () => {
  it("prefers usage/read on the host and never runs the CLI then", async () => {
    const host = hostWith({ usage: mspUsage(NOW) });
    let cliCalls = 0;
    const limits = await readMuseUsageLimits({
      settings,
      hostFactory: host.factory,
      cli: async () => {
        cliCalls++;
        return {};
      },
      observations: new MuseUsageObservations(),
      now: () => NOW,
    });
    expect(limits.status).toBe("available");
    expect(cliCalls).toBe(0);
    expect(host.closed()).toBe(1);
  });

  it("uses a fresh session observation, ignores a stale one, then falls back to the CLI", async () => {
    const observations = new MuseUsageObservations();
    observations.record(mspUsage(NOW - 60_000, 7));
    const fresh = await readMuseUsageLimits({
      settings,
      hostFactory: hostWith({}).factory,
      cli: async () => {
        throw new Error("CLI should not run");
      },
      observations,
      now: () => NOW,
    });
    expect(fresh.windows[0]?.utilization).toBe(7);

    const stale = new MuseUsageObservations();
    stale.record(mspUsage(NOW - 60 * 60_000));
    const viaCli = await readMuseUsageLimits({
      settings,
      hostFactory: hostWith({}).factory,
      cli: async () => ({ schemaVersion: 1, allowance: mspUsage(NOW, 55), reason: null }),
      observations: stale,
      now: () => NOW,
    });
    expect(viaCli.windows[0]?.utilization).toBe(55);
  });

  it("reports unavailable without an allowance, when disabled, and error when the CLI fails", async () => {
    const base = {
      hostFactory: hostWith({}).factory,
      observations: new MuseUsageObservations(),
      now: () => NOW,
    };
    const none = await readMuseUsageLimits({
      ...base,
      settings,
      cli: async () => ({ schemaVersion: 1, allowance: null, reason: "no_allowance" }),
    });
    expect(none.status).toBe("unavailable");
    const disabled = await readMuseUsageLimits({
      ...base,
      settings: { ...settings, enabled: false },
    });
    expect(disabled.status).toBe("unavailable");
    const failed = await readMuseUsageLimits({
      ...base,
      settings,
      cli: async () => {
        throw new Error("boom");
      },
    });
    expect(failed.status).toBe("error");
  });
});

describe("Muse usage observations", () => {
  it("keeps only the newest stamped observation", () => {
    const store = new MuseUsageObservations();
    store.record(mspUsage(NOW, 30));
    store.record(mspUsage(NOW - 1, 90));
    store.record({ tier: "x" });
    expect(store.latest(NOW, 1_000)).toEqual(mspUsage(NOW, 30));
    expect(store.latest(NOW + 5_000, 1_000)).toBeUndefined();
  });

  it("records usage/changed from a session host even before session state exists", () => {
    const observations = new MuseUsageObservations();
    const callbacks = makeMuseHostCallbacks({
      threadId: ThreadId.makeUnsafe("thread-usage"),
      admissions: undefined,
      getState: () => undefined,
      emit: () => undefined,
      observations,
    });
    callbacks.onNotification?.({ method: "usage/changed", params: mspUsage(NOW) });
    expect(observations.latest(NOW, 1_000)).toEqual(mspUsage(NOW));
  });

  it("builds the CLI launch with the usage subcommand", () => {
    expect(resolveMuseLaunch("muse", "linux", {}, () => "/u/muse", ["usage", "--json"])).toEqual({
      command: "/u/muse",
      args: ["usage", "--json"],
    });
  });
});
