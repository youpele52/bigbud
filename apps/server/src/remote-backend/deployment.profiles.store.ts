import { RemoteBackendRelayError } from "@bigbud/contracts/server/remoteBackendRelay.ts";
import type { RemoteBackendProfileRecord } from "../persistence/Services/RemoteBackendProfiles.ts";
import type {
  RemoteBackendRelayProfileDirectory,
  ResolvedRemoteBackendRelayProfile,
} from "./clientRelay.profiles.ts";
import type { DeploymentProfileStore } from "./deployment.types.ts";

/** Public projection only: no target, paths, hashes or host identity reach the renderer. */
function publicProfile(record: RemoteBackendProfileRecord) {
  return {
    profileId: record.profileId,
    label: record.label,
    identity: {
      authority: {
        authorityId: record.authorityId,
        keyFingerprint: record.keyFingerprint,
        keyEpoch: record.keyEpoch,
      },
      installationFingerprint: record.installationFingerprint,
    },
  };
}

/** Private producer: the relay executes exactly the pinned Node binary and relay helper. */
export function resolvedRelayProfile(
  record: RemoteBackendProfileRecord,
): ResolvedRemoteBackendRelayProfile {
  return {
    profile: publicProfile(record),
    executionTargetId: record.executionTargetId,
    deployment: {
      nodeBinary: record.nodeBinary,
      nodeSha256: record.nodeSha256,
      helperEntry: record.helperEntry,
      helperSha256: record.helperSha256,
      authorityId: record.authorityId,
    },
  };
}

/** The persisted profile directory replaces `RemoteBackendRelayProfilesUnavailable` in production. */
export function makePersistedRemoteBackendRelayProfiles(
  store: Pick<DeploymentProfileStore, "list" | "get">,
): RemoteBackendRelayProfileDirectory {
  const unavailable = () =>
    new RemoteBackendRelayError({
      code: "unavailable",
      message: "The remote backend profile directory is unavailable.",
    });
  return {
    list: async (_caller, signal) => {
      signal.throwIfAborted();
      const records = await store.list().catch(() => {
        throw unavailable();
      });
      signal.throwIfAborted();
      return records.length
        ? { availability: "available" as const, profiles: records.slice(0, 64).map(publicProfile) }
        : { availability: "setup-required" as const, profiles: [] };
    },
    resolve: async (profileId, _caller, signal) => {
      signal.throwIfAborted();
      const record = await store.get(profileId).catch(() => {
        throw unavailable();
      });
      signal.throwIfAborted();
      if (!record)
        throw new RemoteBackendRelayError({
          code: "not-found",
          message: "No deployed remote backend has this profile.",
        });
      return resolvedRelayProfile(record);
    },
  };
}
