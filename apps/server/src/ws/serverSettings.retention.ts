import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { ThreadRetentionPolicy } from "@bigbud/contracts/core/settings.threadRetention.ts";
import { ServerSettingsError } from "@bigbud/contracts";
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
    return ["7-days", "14-days", "30-days", "90-days", "never"].includes(policy as string)
      ? (policy as ThreadRetentionPolicy)
      : "malformed";
  } catch {
    return "malformed";
  }
}
