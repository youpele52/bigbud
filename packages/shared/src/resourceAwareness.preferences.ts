import type {
  ResourcePreferences,
  ResourceRule,
  ResourceRuleMutation,
} from "@bigbud/contracts/system-monitor/awareness.ts";

/** Conservative defaults; sensor thresholds come from hardware, never a universal constant. */
export function defaultResourcePreferences(): ResourcePreferences {
  const common = { enabled: true, scope: "host" as const, cooldownSeconds: 600 };
  return {
    version: 1,
    revision: 0,
    enabled: true,
    snoozedUntilMs: 0,
    rules: [
      {
        ...common,
        id: "host-cpu",
        metric: "hostCpu",
        threshold: 95,
        recovery: 90,
        sustainSeconds: 60,
      },
      {
        ...common,
        id: "host-memory",
        metric: "hostMemory",
        threshold: 95,
        recovery: 90,
        sustainSeconds: 30,
      },
      {
        ...common,
        id: "host-disk",
        metric: "disk",
        threshold: 95,
        recovery: 90,
        minimumFreeBytes: 10 * 1024 ** 3,
        recoveryFreeBytes: 12 * 1024 ** 3,
        sustainSeconds: 60,
      },
      { ...common, id: "host-temperature", metric: "temperature", sustainSeconds: 30 },
    ],
  };
}

export function validateResourceRule(rule: ResourceRule): void {
  const app = rule.metric === "appCpu" || rule.metric === "appMemory";
  if (app === (rule.scope === "host")) throw new Error("invalid rule scope");
  if (rule.metric !== "temperature" && rule.threshold === undefined)
    throw new Error("threshold required");
  if (
    rule.threshold !== undefined &&
    rule.recovery !== undefined &&
    rule.recovery >= rule.threshold
  )
    throw new Error("recovery must be below threshold");
  if (
    ["hostCpu", "hostMemory", "disk", "appCpu"].includes(rule.metric) &&
    (rule.threshold ?? 0) > 100
  )
    throw new Error("percentage must not exceed 100");
  if (rule.minimumFreeBytes !== undefined && rule.metric !== "disk")
    throw new Error("free space applies only to disks");
  if (rule.minimumFreeBytes !== undefined && (rule.recoveryFreeBytes ?? 0) <= rule.minimumFreeBytes)
    throw new Error("free space recovery must exceed threshold");
}

/** Builds the next value; callers serialize revision check, durable write, and publication. */
export function changeResourcePreferences(
  current: ResourcePreferences,
  mutation: ResourceRuleMutation,
  now: number,
): ResourcePreferences {
  if (current.revision !== mutation.expectedRevision)
    throw new Error("revision conflict; reload rules");
  let next = { ...current };
  switch (mutation.operation) {
    case "upsert": {
      if (!mutation.rule) throw new Error("rule required");
      validateResourceRule(mutation.rule);
      next.rules = current.rules.some((rule) => rule.id === mutation.rule!.id)
        ? current.rules.map((rule) => (rule.id === mutation.rule!.id ? mutation.rule! : rule))
        : [...current.rules, mutation.rule];
      if (next.rules.length > 64) throw new Error("maximum 64 rules");
      break;
    }
    case "remove":
      if (!mutation.ruleId) throw new Error("ruleId required");
      next.rules = current.rules.filter((rule) => rule.id !== mutation.ruleId);
      break;
    case "enable":
      if (mutation.enabled === undefined) throw new Error("enabled required");
      next.enabled = mutation.enabled;
      break;
    case "snooze":
      if (mutation.snoozeSeconds === undefined) throw new Error("snoozeSeconds required");
      next.snoozedUntilMs = mutation.snoozeSeconds === 0 ? 0 : now + mutation.snoozeSeconds * 1000;
      break;
    case "reset":
      next = { ...defaultResourcePreferences(), revision: current.revision };
      break;
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return current;
  return { ...next, revision: current.revision + 1 };
}
