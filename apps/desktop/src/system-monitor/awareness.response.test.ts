import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { boundedResourceResponse, readResourceView } from "./awareness.response";
import { resourceTrends } from "./awareness.trends";
import { snapshot } from "./awareness.test.helpers";
import { defaultResourcePreferences } from "@bigbud/shared/resourceAwareness.preferences";
import { ResourceAwareness } from "./awareness";
import type { SystemMonitorBridge } from "./bridge";

it("bounds Unicode lists without discarding the useful host summary", () => {
  const result = {
    available: true,
    host: { hostname: "desktop" },
    perCorePercent: Array.from({ length: 128 }, () => ({ name: "🔥".repeat(128) })),
    disks: Array.from({ length: 32 }, () => ({ mount: "🔥".repeat(128) })),
  };
  const original = structuredClone(result);
  const encoded = boundedResourceResponse(result);
  expect(result).toEqual(original);
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(32768);
  expect(JSON.parse(encoded)).toMatchObject({
    available: true,
    host: { hostname: "desktop" },
    omissions: ["perCorePercent"],
  });
});

it.each([
  "perCorePercent",
  "interfaces",
  "processes",
  "trends",
  "disks",
  "temperaturesCelsius",
  "criticalTemperaturesCelsius",
  "alerts",
])("does not mutate shared %s arrays when trimming", (key) => {
  const result = {
    [key]: Array.from({ length: 64 }, () => ({ name: "界".repeat(256) })),
    nextCursor: { generation: 1, digest: "next", offset: 64 },
  };
  const original = structuredClone(result);
  const decoded = JSON.parse(boundedResourceResponse(result));
  expect(result).toEqual(original);
  expect(decoded.omissions).toEqual([key]);
  expect(decoded[key].length).toBeLessThan(64);
  if (key === "processes") {
    expect(decoded.nextCursor).toBeNull();
    expect(decoded.truncatedInventory).toBe(true);
  }
});

it("trims oversized mutation responses without changing live, published or persisted rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bigbud-awareness-response-"));
  const path = join(dir, "preferences.json");
  const owner = new ResourceAwareness(
    { appResourceStatus: () => "ready" } as unknown as SystemMonitorBridge,
    path,
  );
  try {
    const defaults = defaultResourcePreferences();
    const preferences = {
      ...defaults,
      enabled: false,
      rules: Array.from({ length: 64 }, (_, index) => ({
        ...defaults.rules[2]!,
        id: `${index}`.padStart(128, "界"),
        entity: "界".repeat(128),
      })),
    };
    await writeFile(path, JSON.stringify(preferences));
    await owner.preferences.load();
    const published = vi.fn();
    owner.listen(published);
    const response = {
      available: true,
      ...(await owner.mutate({ operation: "snooze", snoozeSeconds: 600, expectedRevision: 0 })),
    };
    const original = structuredClone(response);
    const state = structuredClone(owner.state());
    const publications = structuredClone(published.mock.calls);
    const saved = await readFile(path, "utf8");
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(32768);
    const encoded = boundedResourceResponse(response);
    const decoded = JSON.parse(encoded);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(32768);
    expect(decoded.rulesTruncated).toBe(true);
    expect(decoded.omissions).toEqual(["preferences.rules"]);
    expect(decoded.preferences.rules.length).toBeLessThan(64);
    expect(decoded.preferences.rules.length).toBeGreaterThan(0);
    expect(decoded.preferences.rules).toEqual(
      preferences.rules.slice(0, decoded.preferences.rules.length),
    );
    expect(response).toEqual(original);
    expect(owner.state()).toEqual(state);
    expect(owner.preferences.value.revision).toBe(1);
    expect(owner.preferences.value.rules).toEqual(preferences.rules);
    expect(published.mock.calls).toEqual(publications);
    expect(await readFile(path, "utf8")).toBe(saved);
    await owner.preferences.saveCooldowns({ test: 1000 });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      revision: 1,
      rules: preferences.rules,
    });
  } finally {
    owner.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

it("bounds trends to at most 60 observations, includes latest and preserves source status and gaps", () => {
  const history = Array.from({ length: 300 }, (_, index) => snapshot(1000 + index * 1000));
  history[150]!.cpuPercent!.status = "stale";
  const result = resourceTrends(history, { windowSeconds: 300 }, 300000);
  expect(result.trends.length).toBeLessThanOrEqual(60);
  expect(result.trends.at(-1)?.sampledAtMs).toBe(300000);
  expect(Buffer.byteLength(JSON.stringify(result.trends))).toBeLessThanOrEqual(20000);
  expect(
    resourceTrends([history[150]!], { windowSeconds: 300 }, 300000).trends[0]?.cpuPercent?.status,
  ).toBe("stale");
});

it("returns native details and app support state without a separate subscription", async () => {
  const sample = snapshot(Date.now(), {
    disks: [{ name: "disk", mount: "/", filesystem: "apfs" }],
    temperaturesCelsius: [],
  });
  const owner = {
    state: () => ({
      preferences: defaultResourcePreferences(),
      alerts: [],
      health: "healthy",
      appStatus: "unsupported",
    }),
    readSnapshot: async () => sample,
  } as unknown as ResourceAwareness;
  const details = await readResourceView(owner, {
    view: "details",
    categories: ["disks", "sensors"],
  });
  expect(details.disks).toEqual(sample.disks);
  expect(details.appResources).toMatchObject({ status: "unsupported" });
  expect(details).not.toHaveProperty("perCorePercent");
});

it("preserves the latest trend through final serialization with 64 large alerts", () => {
  const history = Array.from({ length: 60 }, (_, index) => snapshot(1000 + index * 1000));
  const response = {
    ...resourceTrends(history, { windowSeconds: 60 }, 60000),
    alerts: Array.from({ length: 64 }, (_, index) => ({
      id: `${index}`.padStart(128, "界"),
      entity: "界".repeat(128),
      metric: "hostCpu",
      scope: "host",
      state: "active",
      value: 96,
      threshold: 90,
      sampledAtMs: 60000,
    })),
  };
  const original = structuredClone(response);
  const encoded = boundedResourceResponse(response);
  const result = JSON.parse(encoded);
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(32768);
  expect(result.trends.length).toBeGreaterThan(0);
  expect(result.trends.length).toBeLessThan(60);
  expect(result.trends.at(-1).sampledAtMs).toBe(60000);
  expect(result.selectedSamples).toBe(result.trends.length);
  expect(result.observedSamples).toBe(60);
  expect(result.sampling).toContain("including the latest");
  expect(result.sampling).not.toContain("Evenly");
  expect(response).toEqual(original);
});

it.each([false, true])("reports no latest sample when trends are empty (omitted=%s)", (omitted) => {
  const response = {
    ...resourceTrends(omitted ? [snapshot(10000)] : [], {}, 10000),
    padding: omitted ? "x".repeat(31900) : "",
  };
  const original = structuredClone(response);
  const encoded = boundedResourceResponse(response);
  const result = JSON.parse(encoded);
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(32768);
  expect(result.trends).toEqual([]);
  expect(result.selectedSamples).toBe(0);
  expect(result.observedSamples).toBe(omitted ? 1 : 0);
  expect(result.sampling).not.toContain("including the latest");
  expect(result.omissions).toEqual(omitted ? ["trends"] : []);
  expect(response).toEqual(original);
});
