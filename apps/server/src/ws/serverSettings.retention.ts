import { ServerSettingsError, type ServerSettings } from "@bigbud/contracts/core/settings.ts";
import {
  THREAD_RETENTION_POLICIES,
  type ThreadRetentionPolicy,
} from "@bigbud/contracts/core/settings.threadRetention.ts";
import { Effect } from "effect";

export interface ThreadRetentionSettingsOperations {
  /** Called only after the retention service consumes policy-change authorization. */
  readonly setThreadRetentionPolicy?: (
    policy: ThreadRetentionPolicy,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly initializeThreadRetentionPolicy?: (
    policy: ThreadRetentionPolicy,
    source: ThreadRetentionAuthorizationSource,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
}

export type ThreadRetentionRolloutSource =
  | "rollout-automatic"
  | "rollout-protected"
  | "rollout-staged";
export type ThreadRetentionAuthorizationSource = ThreadRetentionRolloutSource | "explicit";
export function reconcileThreadRetentionPolicy(
  settings: ServerSettings,
  authorizedPolicy: ThreadRetentionPolicy,
): ServerSettings {
  return settings.threadRetentionPolicy === authorizedPolicy
    ? settings
    : { ...settings, threadRetentionPolicy: authorizedPolicy };
}

export function preserveThreadRetentionPolicy(
  sparseSettings: Record<string, unknown>,
  settings: ServerSettings,
): void {
  sparseSettings.threadRetentionPolicy = settings.threadRetentionPolicy;
}

export function rawThreadRetentionPolicy(
  raw: string,
): ThreadRetentionPolicy | "absent" | "malformed" {
  try {
    const decoded = JSON.parse(raw) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
      return "malformed";
    if (!Object.prototype.hasOwnProperty.call(decoded, "threadRetentionPolicy")) return "absent";
    const policy = (decoded as Record<string, unknown>).threadRetentionPolicy;
    return (THREAD_RETENTION_POLICIES as readonly unknown[]).includes(policy)
      ? (policy as ThreadRetentionPolicy)
      : "malformed";
  } catch {
    return "malformed";
  }
}
