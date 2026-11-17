import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import {
  RemoteBackendRelayError,
  type RemoteBackendRelayProfile,
  type RemoteBackendRelayListResult,
} from "@bigbud/contracts/server/remoteBackendRelay.ts";
import type { ClientRelayDeployment } from "./clientRelay.ssh.ts";

/** Private producer output. Never decode deployment paths, hashes or commands from renderer RPC. */
export interface ResolvedRemoteBackendRelayProfile {
  readonly profile: RemoteBackendRelayProfile;
  readonly executionTargetId: string;
  readonly deployment: ClientRelayDeployment;
}
export interface RemoteBackendRelayProfileDirectory {
  readonly list: (callerId: string, signal: AbortSignal) => Promise<RemoteBackendRelayListResult>;
  readonly resolve: (
    profileId: string,
    callerId: string,
    signal: AbortSignal,
  ) => Promise<ResolvedRemoteBackendRelayProfile>;
}
export class RemoteBackendRelayProfiles extends ServiceMap.Service<
  RemoteBackendRelayProfiles,
  RemoteBackendRelayProfileDirectory
>()("bigbud/remote-backend/RelayProfiles") {}

/** Fallback when no persisted profile directory is composed (remote mode, tests). Production local
 * backends compose `makePersistedRemoteBackendRelayProfiles` through `RemoteBackendDeploymentLive`. */
export const unavailableRemoteBackendRelayProfiles: RemoteBackendRelayProfileDirectory =
  Object.freeze<RemoteBackendRelayProfileDirectory>({
    list: async (_caller, signal) => {
      signal.throwIfAborted();
      return { availability: "setup-required" as const, profiles: [] };
    },
    resolve: async (_profile, _caller, signal) => {
      signal.throwIfAborted();
      throw new RemoteBackendRelayError({
        code: "setup-required",
        message: "A verified installed backend profile is required before opening a relay.",
      });
    },
  });
export const RemoteBackendRelayProfilesUnavailable = Layer.succeed(
  RemoteBackendRelayProfiles,
  unavailableRemoteBackendRelayProfiles,
);
