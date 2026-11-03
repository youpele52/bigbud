import { expect, it } from "vitest";
import { Schema } from "effect";
import { ResourceRead, ResourceRuleMutation } from "@bigbud/contracts/system-monitor/awareness.ts";
import { resourceReadings } from "./resourceAwareness.metrics.ts";
import {
  changeResourcePreferences,
  defaultResourcePreferences,
} from "./resourceAwareness.preferences.ts";
import { ready, resourceSnapshot } from "./resourceAwareness.test.helpers.ts";

it("never invents critical temperatures or uses stale/unsupported sensors", () => {
  const rule = defaultResourcePreferences().rules[3]!;
  const snapshot = resourceSnapshot(1000, {
    temperaturesCelsius: [{ name: "cpu", metric: ready(99, 1000) }],
  });
  expect(resourceReadings(snapshot, rule, 1000)).toEqual([]);
  snapshot.criticalTemperaturesCelsius = [{ name: "cpu", metric: ready(98, 1000) }];
  expect(resourceReadings(snapshot, rule, 1000)[0]).toMatchObject({
    threshold: 98,
    recovery: 93,
    over: true,
  });
  snapshot.sensorsTruncated = true;
  expect(resourceReadings(snapshot, rule, 1000)).toEqual([]);
  expect(resourceReadings(snapshot, { ...rule, entity: "cpu" }, 1000)).toHaveLength(1);
  expect(resourceReadings(snapshot, { ...rule, entity: "cpu" }, 40000)).toEqual([]);
});

it("suppresses incomplete app attribution and distinguishes core and inclusive", () => {
  const rule = {
    id: "budget",
    enabled: true,
    scope: "core" as const,
    metric: "appMemory" as const,
    threshold: 100,
    sustainSeconds: 60,
    cooldownSeconds: 600,
  };
  const snapshot = resourceSnapshot(1000, {
    appResources: {
      generation: 1,
      sampledAtMs: 1000,
      incomplete: false,
      core: { role: "desktop", processCount: 1, residentBytes: ready(50, 1000) },
      inclusive: { role: "tools", processCount: 2, residentBytes: ready(150, 1000) },
      groups: [],
    },
  });
  expect(resourceReadings(snapshot, rule, 1000)[0]?.over).toBe(false);
  expect(resourceReadings(snapshot, { ...rule, scope: "inclusive" }, 1000)[0]?.over).toBe(true);
  snapshot.appResources!.incomplete = true;
  expect(resourceReadings(snapshot, rule, 1000)).toEqual([]);
});

it("validates bounds, revisions and rule semantics without changing defaults", () => {
  const preferences = defaultResourcePreferences();
  expect(() => Schema.decodeUnknownSync(ResourceRead)({ limit: 101 })).toThrow();
  expect(() => Schema.decodeUnknownSync(ResourceRead)({ windowSeconds: Infinity })).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(ResourceRuleMutation)({
      operation: "snooze",
      expectedRevision: 0,
      snoozeSeconds: NaN,
    }),
  ).toThrow();
  expect(() =>
    changeResourcePreferences(
      preferences,
      { operation: "enable", enabled: false, expectedRevision: 99 },
      1000,
    ),
  ).toThrow("conflict");
  expect(() =>
    changeResourcePreferences(
      preferences,
      {
        operation: "upsert",
        expectedRevision: 0,
        rule: { ...preferences.rules[0]!, recovery: 100 },
      },
      1000,
    ),
  ).toThrow("recovery");
  expect(
    changeResourcePreferences(
      preferences,
      { operation: "upsert", expectedRevision: 0, rule: preferences.rules[0]! },
      1000,
    ),
  ).toBe(preferences);
});
