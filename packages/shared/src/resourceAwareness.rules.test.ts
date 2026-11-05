import { describe, expect, it } from "vitest";
import { ResourceRuleEvaluator } from "./resourceAwareness.rules.ts";
import { defaultResourcePreferences } from "./resourceAwareness.preferences.ts";
import { ready, resourceSnapshot } from "./resourceAwareness.test.helpers.ts";

const defaults = defaultResourcePreferences();
const prefs = { ...defaults, rules: [{ ...defaults.rules[0]!, sustainSeconds: 3 }] };
function feed(evaluator: ResourceRuleEvaluator, start: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const time = start + index * 1000;
    return evaluator.evaluate(resourceSnapshot(time), prefs, time);
  }).flat();
}

describe("resource rule evidence", () => {
  it("sustains distinct samples, deduplicates ongoing alerts and respects hysteresis/cooldown", () => {
    const evaluator = new ResourceRuleEvaluator();
    expect(feed(evaluator, 1000, 3)).toEqual([]);
    expect(feed(evaluator, 4000, 1)).toHaveLength(1);
    expect(feed(evaluator, 5000, 10)).toEqual([]);
    evaluator.evaluate(resourceSnapshot(15000, { cpuPercent: ready(92, 15000) }), prefs, 15000);
    expect(evaluator.alerts()).toHaveLength(1);
    evaluator.evaluate(resourceSnapshot(16000, { cpuPercent: ready(89, 16000) }), prefs, 16000);
    expect(evaluator.alerts()).toEqual([]);
    expect(feed(evaluator, 17000, 6)).toEqual([]);
    expect(evaluator.alerts()[0]?.notifiedAtMs).toBeUndefined();
  });
  it("duplicates, stale metrics, future samples and long gaps cannot manufacture sustained evidence", () => {
    for (const invalid of ["duplicate", "stale", "future", "gap"] as const) {
      const evaluator = new ResourceRuleEvaluator();
      evaluator.evaluate(resourceSnapshot(1000), prefs, 1000);
      const time = invalid === "gap" ? 10000 : 4000;
      const metric =
        invalid === "duplicate"
          ? ready(96, 1000)
          : invalid === "stale"
            ? { ...ready(96, time), status: "stale" as const }
            : invalid === "future"
              ? ready(96, 10000)
              : ready(96, time);
      expect(
        evaluator.evaluate(resourceSnapshot(time, { cpuPercent: metric }), prefs, time),
      ).toEqual([]);
      expect(evaluator.alerts()).toEqual([]);
    }
  });
  it("epoch, baseline, missing values and snooze invalidate continuity without declaring recovery", () => {
    const evaluator = new ResourceRuleEvaluator();
    feed(evaluator, 1000, 4);
    evaluator.evaluate(resourceSnapshot(5000, { epoch: 2, baseline: true }), prefs, 5000);
    expect(evaluator.alerts()[0]?.state).toBe("unknown");
    const missing = resourceSnapshot(6000);
    delete missing.cpuPercent;
    evaluator.evaluate(missing, prefs, 6000);
    expect(evaluator.alerts()[0]?.state).toBe("unknown");
    const snoozed = { ...prefs, snoozedUntilMs: 10000 };
    evaluator.evaluate(resourceSnapshot(7000), snoozed, 7000);
    expect(evaluator.evaluate(resourceSnapshot(11000), snoozed, 11000)).toEqual([]);
    expect(evaluator.alerts()[0]?.state).toBe("unknown");
  });
  it("resets sustained evidence on restart while restoring persisted cooldown", () => {
    const first = new ResourceRuleEvaluator();
    feed(first, 1000, 4);
    const restarted = new ResourceRuleEvaluator(first.persistedCooldowns());
    expect(feed(restarted, 5000, 4)).toEqual([]);
    expect(restarted.alerts()[0]?.notifiedAtMs).toBeUndefined();
  });
  it("uses disk source timestamps and AND-low-free threshold, not repeated snapshot timestamps", () => {
    const evaluator = new ResourceRuleEvaluator();
    const preferences = { ...defaults, rules: [{ ...defaults.rules[2]!, sustainSeconds: 30 }] };
    const sample = (time: number, source: number, free = 1) =>
      resourceSnapshot(time, {
        disks: [
          {
            name: "disk",
            mount: "/",
            filesystem: "apfs",
            removable: { value: false, status: "ready", sampledAtMs: source },
            readOnly: { value: false, status: "ready", sampledAtMs: source },
            usedBytes: ready(99, source),
            totalBytes: ready(100, source),
            freeBytes: ready(free, source),
          },
        ],
      });
    const events = [];
    for (let time = 1000; time <= 31000; time += 1000)
      events.push(
        ...evaluator.evaluate(
          sample(time, 1000 + Math.floor((time - 1000) / 10000) * 10000),
          preferences,
          time,
        ),
      );
    expect(events).toHaveLength(1);
    evaluator.evaluate(sample(41000, 41000, 13 * 1024 ** 3), preferences, 41000);
    expect(evaluator.alerts()).toEqual([]);
  });
});
