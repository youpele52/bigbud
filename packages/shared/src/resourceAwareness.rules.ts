import type {
  ResourceAlert,
  ResourcePreferences,
} from "@bigbud/contracts/system-monitor/awareness.ts";
import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { resourceReadings } from "./resourceAwareness.metrics.ts";

interface Evidence {
  since: number;
  last: number;
  generation?: number;
  alert?: ResourceAlert;
}

/** Bounded per-entity evidence. Only distinct source timestamps can sustain an incident. */
export class ResourceRuleEvaluator {
  private evidence = new Map<string, Evidence>();
  private cooldowns = new Map<string, number>();
  private epoch: number | undefined;
  private lastSnapshot = 0;
  private revision = -1;
  private snoozed = false;
  private truncated = false;

  constructor(cooldowns: Readonly<Record<string, number>> = {}) {
    for (const [key, value] of Object.entries(cooldowns).slice(-256)) {
      if (Number.isFinite(value)) this.cooldowns.set(key, value);
    }
  }

  reset(): void {
    for (const value of this.evidence.values()) {
      value.since = 0;
      value.last = 0;
      if (value.alert) value.alert = { ...value.alert, state: "unknown" };
    }
  }

  alerts(): ResourceAlert[] {
    return [...this.evidence.values()]
      .flatMap((value) => (value.alert ? [value.alert] : []))
      .slice(0, 64);
  }

  isTruncated(): boolean {
    return this.truncated || [...this.evidence.values()].filter((value) => value.alert).length > 64;
  }

  persistedCooldowns(): Record<string, number> {
    return Object.fromEntries(this.cooldowns);
  }

  evaluate(
    snapshot: MonitorSnapshot,
    preferences: ResourcePreferences,
    now: number,
  ): ResourceAlert[] {
    this.truncated = false;
    if (this.revision !== preferences.revision) {
      this.evidence.clear();
      this.revision = preferences.revision;
    }
    const snoozed = !preferences.enabled || preferences.snoozedUntilMs > now;
    if (
      snoozed ||
      this.snoozed ||
      this.epoch !== snapshot.epoch ||
      snapshot.baseline ||
      now - this.lastSnapshot > 5000 ||
      snapshot.sampledAtMs > now + 2000 ||
      now - snapshot.sampledAtMs > 5000
    )
      this.reset();
    this.snoozed = snoozed;
    this.epoch = snapshot.epoch;
    this.lastSnapshot = now;
    if (
      snoozed ||
      snapshot.baseline ||
      now - snapshot.sampledAtMs > 5000 ||
      snapshot.sampledAtMs > now + 2000
    )
      return [];
    const seen = new Set<string>();
    const emitted: ResourceAlert[] = [];
    for (const rule of preferences.rules) {
      if (!rule.enabled) continue;
      for (const reading of resourceReadings(snapshot, rule, now)) {
        const key = JSON.stringify([rule.id, reading.entity]);
        if (seen.has(key)) continue;
        seen.add(key);
        let value = this.evidence.get(key);
        if (!value) {
          if (this.evidence.size >= 256) {
            this.truncated = true;
            continue;
          }
          value = { since: 0, last: 0 };
          this.evidence.set(key, value);
        }
        if (rule.metric === "appCpu" || rule.metric === "appMemory") {
          const generation = snapshot.appResources?.generation;
          if (value.generation !== generation) {
            value.since = 0;
            value.last = 0;
            if (value.alert) value.alert.state = "unknown";
          }
          if (generation !== undefined) value.generation = generation;
        }
        if (reading.sampledAtMs === value.last) continue;
        if (
          reading.sampledAtMs < value.last ||
          reading.sampledAtMs - value.last > reading.maxAgeMs
        ) {
          value.since = 0;
          if (value.alert) value.alert.state = "unknown";
        }
        value.last = reading.sampledAtMs;
        if (reading.recovered) {
          delete value.alert;
          value.since = 0;
          continue;
        }
        if (!reading.over) {
          value.since = 0;
          continue;
        }
        if (value.since === 0) value.since = reading.sampledAtMs;
        if (value.alert?.state === "active") {
          value.alert = { ...value.alert, value: reading.value, sampledAtMs: reading.sampledAtMs };
          continue;
        }
        if (reading.sampledAtMs - value.since < rule.sustainSeconds * 1000) continue;
        const previous = value.alert;
        value.alert = {
          id: previous?.id ?? `${snapshot.epoch}:${rule.id}:${reading.entity}:${value.since}`,
          ruleId: rule.id,
          entity: reading.entity,
          metric: rule.metric,
          scope: rule.scope,
          state: "active",
          value: reading.value,
          threshold: reading.threshold,
          startedAtMs: previous?.startedAtMs ?? value.since,
          sampledAtMs: reading.sampledAtMs,
        };
        if (
          !previous &&
          now - (this.cooldowns.get(key) ?? -Infinity) >= rule.cooldownSeconds * 1000
        ) {
          value.alert.notifiedAtMs = now;
          emitted.push(value.alert);
          this.cooldowns.delete(key);
          this.cooldowns.set(key, now);
          if (this.cooldowns.size > 256) this.cooldowns.delete(this.cooldowns.keys().next().value!);
        }
      }
    }
    for (const [key, value] of this.evidence) {
      if (!seen.has(key)) {
        if (!value.alert) this.evidence.delete(key);
        else {
          value.since = 0;
          value.last = 0;
          value.alert.state = "unknown";
        }
      }
    }
    return emitted;
  }
}
