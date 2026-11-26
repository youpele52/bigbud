import type { InstalledStartupRefusalReason } from "./remoteAgentComposition.installedStartup.ts";
import type { RemoteAgentComposition } from "./remoteAgentComposition.ts";

/**
 * Verified installed-agent compositions, keyed by their exact endpoint. A
 * startup registers one only after an independent observation and admission
 * check; nothing here may bootstrap, dial legacy SSH, or promote a pending build.
 */
const installedStartups = new Map<string, RemoteAgentComposition>();

/**
 * Sticky per-endpoint refusals. Once normal startup has refused an endpoint,
 * later lookups must not silently build the process-default bootstrap
 * composition: refusal is not permission to fall back.
 */
const installedRefusals = new Map<string, InstalledStartupRefusalReason>();

export function registerInstalledRemoteAgentStartup(
  executionTargetId: string,
  composition: RemoteAgentComposition,
): void {
  installedRefusals.delete(executionTargetId);
  installedStartups.set(executionTargetId, composition);
}

export function refuseInstalledRemoteAgentStartup(
  executionTargetId: string,
  reason: InstalledStartupRefusalReason,
): void {
  installedStartups.delete(executionTargetId);
  installedRefusals.set(executionTargetId, reason);
}

/** The verified installed startup for this endpoint, if normal startup composed one. */
export function installedRemoteAgentStartup(
  executionTargetId: string | null | undefined,
): RemoteAgentComposition | null {
  if (!executionTargetId) return null;
  return installedStartups.get(executionTargetId) ?? null;
}

/** The typed reason normal startup refused this endpoint, if it did. */
export function installedRemoteAgentStartupRefusal(
  executionTargetId: string | null | undefined,
): InstalledStartupRefusalReason | null {
  if (!executionTargetId) return null;
  return installedRefusals.get(executionTargetId) ?? null;
}

export function installedRemoteAgentStartups(): ReadonlyMap<string, RemoteAgentComposition> {
  return installedStartups;
}

export function clearInstalledRemoteAgentStartups(): void {
  installedStartups.clear();
  installedRefusals.clear();
}
