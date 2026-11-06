import { createHash } from "node:crypto";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { OrganizationRuntimePolicy } from "../persistence/Services/ThreadOrganizationRuntime.ts";
import type { OrganizationPolicy } from "./organizationProtocol.ts";

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function organizationPolicySettings(
  settings: ServerSettings,
  installation: "new" | "existing",
) {
  const targetEnabled = settings.inyosiraPresentTargetEnabled ?? installation === "new";
  const shortFingerprint = fingerprint([
    settings.inyosiraIdleCleanupEnabled,
    settings.inyosiraIdleTimeoutMinutes,
    settings.inyosiraIdleDestination,
  ]);
  const olderFingerprint = fingerprint([
    settings.inyosiraOlderThreadsEnabled,
    settings.inyosiraOlderThreadsDays,
  ]);
  const targetFingerprint = fingerprint([
    targetEnabled,
    settings.inyosiraPresentTarget,
    settings.inyosiraGraceMinutes,
  ]);
  return {
    targetEnabled,
    shortFingerprint,
    olderFingerprint,
    targetFingerprint,
    policyFingerprint: fingerprint([shortFingerprint, olderFingerprint, targetFingerprint]),
  };
}
export function organizationWirePolicy(
  settings: ServerSettings,
  installation: "new" | "existing",
  stored: OrganizationRuntimePolicy,
): OrganizationPolicy {
  const policy = organizationPolicySettings(settings, installation);
  return {
    version: stored.policyVersion,
    fingerprint: policy.policyFingerprint,
    ...(stored.olderPolicyChangedAtMs !== null
      ? { olderPolicyChangedAtMs: stored.olderPolicyChangedAtMs }
      : {}),
    scheduling: {
      idleEnabled: settings.inyosiraIdleCleanupEnabled,
      idleTimeoutMs: settings.inyosiraIdleTimeoutMinutes * 60000,
      idleDestination: settings.inyosiraIdleDestination === "done" ? 4 : 3,
      olderEnabled: settings.inyosiraOlderThreadsEnabled,
      olderTimeoutMs: settings.inyosiraOlderThreadsDays * 86400000,
      ...(policy.targetEnabled ? { presentTarget: settings.inyosiraPresentTarget } : {}),
      ...(stored.targetDrainNotBeforeMs !== null
        ? { targetNotBeforeMs: stored.targetDrainNotBeforeMs }
        : {}),
      graceMs: settings.inyosiraGraceMinutes * 60000,
    },
  };
}
