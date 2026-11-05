export const SYSTEM_RESOURCE_READ_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {
    view: { type: "string", enum: ["summary", "details", "processes", "trends", "rules"] },
    categories: {
      type: "array",
      maxItems: 6,
      items: { type: "string", enum: ["cpu", "memory", "disks", "sensors", "app", "network"] },
    },
    windowSeconds: { type: "number", minimum: 30, maximum: 300 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    search: { type: "string", maxLength: 256 },
    sort: { type: "string", enum: ["cpu", "memory", "name", "pid"] },
    descending: { type: "boolean" },
    cursor: {
      type: "object",
      additionalProperties: false,
      required: ["generation", "digest", "offset"],
      properties: {
        generation: { type: "integer", minimum: 1 },
        digest: { type: "string", pattern: "^[0-9]{1,20}$" },
        offset: { type: "integer", minimum: 0 },
      },
    },
  },
};
export const CONFIGURE_SYSTEM_RESOURCE_RULES_DESCRIPTION =
  "Configure persisted desktop resource monitoring only when the user explicitly asks. Read get_system_resources(view: rules) first and supply expectedRevision. Supports upsert/remove rules, monitoring enable/disable, snooze (0 resumes), and reset defaults. Does not control processes. Threshold units: percent for CPU/RAM/disk, bytes for appMemory, Celsius for temperature. App scope must be core or inclusive; other metrics use host. A missing temperature threshold uses hardware critical temperature only; unavailable sensors never alarm.";
const number = { type: "number", minimum: 0, maximum: 1e15 };
export const SYSTEM_RESOURCE_RULE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "operation"],
  properties: {
    expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    operation: { type: "string", enum: ["upsert", "remove", "enable", "snooze", "reset"] },
    enabled: { type: "boolean" },
    snoozeSeconds: { type: "number", minimum: 0, maximum: 86400 },
    ruleId: { type: "string", minLength: 1, maxLength: 128 },
    rule: {
      type: "object",
      additionalProperties: false,
      required: ["id", "enabled", "metric", "scope", "sustainSeconds", "cooldownSeconds"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        enabled: { type: "boolean" },
        metric: {
          type: "string",
          enum: ["hostCpu", "hostMemory", "disk", "temperature", "appCpu", "appMemory"],
        },
        scope: { type: "string", enum: ["host", "core", "inclusive"] },
        entity: { type: "string", minLength: 1, maxLength: 128 },
        threshold: number,
        recovery: number,
        minimumFreeBytes: number,
        recoveryFreeBytes: number,
        sustainSeconds: { type: "number", minimum: 1, maximum: 3600 },
        cooldownSeconds: { type: "number", minimum: 0, maximum: 86400 },
      },
    },
  },
};
