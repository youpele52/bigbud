import { Cause, Effect, Schema } from "effect";
import type * as SchemaIssue from "effect/SchemaIssue";
import { ServerConfig, ServerConfigStreamEvent } from "@bigbud/contracts/server/server";

type ConfigStage = "keybindings" | "providers" | "discovery" | "settings" | "snapshot" | "update";
const AREAS = new Set([
  "cwd",
  "storage",
  "keybindingsConfigPath",
  "keybindings",
  "issues",
  "providers",
  "discovery",
  "availableEditors",
  "availableTerminals",
  "observability",
  "workspaceCapabilities",
  "settings",
]);
const SCHEMA_FIELDS = new Set([
  ...AREAS,
  "config",
  "payload",
  "version",
  "type",
  "provider",
  "enabled",
  "installed",
  "status",
  "auth",
  "checkedAt",
  "initialProbeComplete",
  "models",
  "id",
  "slug",
  "name",
  "label",
  "group",
  "subProviderID",
  "capabilities",
  "reasoningEffortLevels",
  "value",
  "nativeAgents",
  "description",
  "message",
  "slashCommands",
  "skills",
  "agents",
  "source",
  "path",
  "kind",
  "notesDir",
  "kanbanDir",
  "logsDirectoryPath",
  "localTracingEnabled",
  "otlpTracesUrl",
  "otlpTracesEnabled",
  "otlpMetricsUrl",
  "otlpMetricsEnabled",
  "remoteAgent",
  "supportsDirectoryWatch",
  "supportsPtyReattach",
  "contextWindow",
  "maxOutputTokens",
  "supportsImages",
  "supportsReasoning",
  "effort",
  "defaultEffort",
  "providerOptions",
  "executionTargetId",
  "defaultChatCwd",
  "enableAssistantStreaming",
  "enableThinkingStreaming",
  "threadRetentionPolicy",
]);
const MAX_PATH_SEGMENTS = 16;
const MAX_PATH_CHARS = 240;
const lastReportedAt = new Map<ConfigStage, number>();
const REPORT_INTERVAL_MS = 60_000;

/** Projects a bounded allowlisted structural path, never actual values or arbitrary key names. */
export function configSchemaDiagnostic(issue: SchemaIssue.Issue): {
  readonly area: string;
  readonly structuralPath: string;
  readonly category: SchemaIssue.Issue["_tag"];
} {
  let area = "unknown";
  const path: Array<string> = [];
  const diagnostic = (category: SchemaIssue.Issue["_tag"]) =>
    ({
      area,
      structuralPath: (path.join("") || "unknown").slice(0, MAX_PATH_CHARS),
      category,
    }) as const;
  let current = issue;
  for (let depth = 0; depth < 32; depth += 1) {
    switch (current._tag) {
      case "Pointer":
        for (const part of current.path.slice(0, MAX_PATH_SEGMENTS - path.length)) {
          if (typeof part === "string" && SCHEMA_FIELDS.has(part)) {
            if (area === "unknown" && AREAS.has(part)) area = part;
            path.push(`${path.length === 0 ? "" : "."}${part}`);
          } else if (
            typeof part === "number" &&
            Number.isInteger(part) &&
            part >= 0 &&
            part <= 1_000_000
          ) {
            path.push(`[${part}]`);
          } else {
            path.push(`${path.length === 0 ? "" : "."}[redacted]`);
          }
        }
        current = current.issue;
        break;
      case "Encoding":
      case "Filter":
        current = current.issue;
        break;
      case "Composite":
      case "AnyOf":
        if (!current.issues[0]) return diagnostic(current._tag);
        current = current.issues[0];
        break;
      default:
        return diagnostic(current._tag);
    }
  }
  return diagnostic(current._tag);
}

function reportConfigFailure(stage: ConfigStage, issue?: SchemaIssue.Issue) {
  return Effect.suspend(() => {
    const now = Date.now();
    const previous = lastReportedAt.get(stage);
    if (previous !== undefined && now - previous < REPORT_INTERVAL_MS) return Effect.void;
    lastReportedAt.set(stage, now);
    return Effect.logWarning("Server configuration failed", {
      stage,
      ...(issue ? configSchemaDiagnostic(issue) : { category: "acquisition_failed" }),
    });
  });
}

/** Records acquisition failures without serializing causes or provider data. */
export function observeConfigStage<A, E, R>(
  stage: ConfigStage,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.void : reportConfigFailure(stage),
    ),
  );
}

/** Rejects invalid producer output before RPC serialization, retaining a value-free failure. */
export function validateServerConfig(config: ServerConfig): Effect.Effect<ServerConfig> {
  return Schema.encodeEffect(ServerConfig)(config).pipe(
    Effect.catch((error) =>
      reportConfigFailure("snapshot", error.issue).pipe(
        Effect.andThen(Effect.die(new Error("Server configuration snapshot is invalid."))),
      ),
    ),
    Effect.as(config),
  );
}

/** Applies the same wire contract to incremental config events before encoding. */
export function validateServerConfigEvent(
  event: ServerConfigStreamEvent,
): Effect.Effect<ServerConfigStreamEvent> {
  return Schema.encodeEffect(ServerConfigStreamEvent)(event).pipe(
    Effect.catch((error) =>
      reportConfigFailure("update", error.issue).pipe(
        Effect.andThen(Effect.die(new Error("Server configuration update is invalid."))),
      ),
    ),
    Effect.as(event),
  );
}
