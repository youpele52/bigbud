import { Schema } from "effect";

const bounded = (minimum: number, maximum: number) =>
  Schema.Number.check(Schema.isBetween({ minimum, maximum }));
const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const ResourceRule = Schema.Struct({
  id: identifier,
  enabled: Schema.Boolean,
  metric: Schema.Literals(["hostCpu", "hostMemory", "disk", "temperature", "appCpu", "appMemory"]),
  scope: Schema.Literals(["host", "core", "inclusive"]),
  entity: Schema.optional(identifier),
  threshold: Schema.optional(bounded(0, 1e15)),
  recovery: Schema.optional(bounded(0, 1e15)),
  minimumFreeBytes: Schema.optional(bounded(0, 1e15)),
  recoveryFreeBytes: Schema.optional(bounded(0, 1e15)),
  sustainSeconds: bounded(1, 3600),
  cooldownSeconds: bounded(0, 86400),
});
export type ResourceRule = typeof ResourceRule.Type;
export const ResourcePreferences = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  enabled: Schema.Boolean,
  snoozedUntilMs: bounded(0, Number.MAX_SAFE_INTEGER),
  rules: Schema.Array(ResourceRule).check(Schema.isMaxLength(64)),
});
export type ResourcePreferences = typeof ResourcePreferences.Type;
export const ResourceRuleMutation = Schema.Struct({
  expectedRevision: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  operation: Schema.Literals(["upsert", "remove", "enable", "snooze", "reset"]),
  rule: Schema.optional(ResourceRule),
  ruleId: Schema.optional(identifier),
  enabled: Schema.optional(Schema.Boolean),
  snoozeSeconds: Schema.optional(bounded(0, 86400)),
});
export type ResourceRuleMutation = typeof ResourceRuleMutation.Type;
export const ResourceRead = Schema.Struct({
  view: Schema.optional(Schema.Literals(["summary", "details", "processes", "trends", "rules"])),
  categories: Schema.optional(
    Schema.Array(Schema.Literals(["cpu", "memory", "disks", "sensors", "app", "network"])).check(
      Schema.isMaxLength(6),
    ),
  ),
  windowSeconds: Schema.optional(bounded(30, 300)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  sort: Schema.optional(Schema.Literals(["cpu", "memory", "name", "pid"])),
  descending: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(
    Schema.Struct({
      generation: Schema.Int.check(Schema.isGreaterThan(0)),
      digest: Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/)),
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export type ResourceRead = typeof ResourceRead.Type;
export interface ResourceAlert {
  id: string;
  ruleId: string;
  entity: string;
  metric: ResourceRule["metric"];
  scope: ResourceRule["scope"];
  state: "active" | "unknown";
  value: number;
  threshold: number;
  startedAtMs: number;
  sampledAtMs: number;
  notifiedAtMs?: number;
  acknowledged?: boolean;
}
export interface ResourceAwarenessState {
  stateSequence?: number;
  preferences: ResourcePreferences;
  health: "healthy" | "warming" | "unavailable" | "disabled";
  diagnostic?: string;
  appStatus?: "ready" | "unsupported" | "unavailable";
  sampledAtMs?: number;
  alerts: ResourceAlert[];
  alertsTruncated?: boolean;
}
