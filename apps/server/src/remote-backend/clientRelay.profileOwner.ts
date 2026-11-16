import { openClientRelayOwner } from "./clientRelay.owner.ts";
import { makeClientRelaySshChannels } from "./clientRelay.ssh.ts";
import type { ResolvedRemoteBackendRelayProfile } from "./clientRelay.profiles.ts";

export interface RemoteBackendRelayOwnedEndpoint {
  readonly baseUrl: string;
  readonly localCredential: string;
  readonly dispose: () => Promise<void>;
}
/** Only a private approved-profile producer may supply this input; never an RPC payload. */
export async function openRemoteBackendRelayProfileOwner(
  profile: ResolvedRemoteBackendRelayProfile,
  allowedOrigins: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<RemoteBackendRelayOwnedEndpoint> {
  signal.throwIfAborted();
  if (
    !profile.executionTargetId.startsWith("ssh:") ||
    profile.deployment.authorityId !== profile.profile.identity.authority.authorityId
  )
    throw new Error("Approved backend profile has inconsistent ownership.");
  const ssh = makeClientRelaySshChannels(profile);
  let owner: Awaited<ReturnType<typeof openClientRelayOwner>> | undefined;
  const abort = () => {
    owner?.dispose();
    void ssh.dispose().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    owner = await openClientRelayOwner({ allowedOrigins, openChannel: ssh.openChannel });
    signal.throwIfAborted();
    let disposal: Promise<void> | undefined;
    const selected = owner;
    return {
      baseUrl: selected.baseUrl,
      localCredential: selected.token,
      dispose: () =>
        (disposal ??= (async () => {
          signal.removeEventListener("abort", abort);
          selected.dispose();
          await ssh.dispose();
        })()),
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    owner?.dispose();
    await ssh.dispose();
    throw error;
  }
}
