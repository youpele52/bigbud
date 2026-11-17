import type { OrchestrationDeliveryLifecycle } from "@bigbud/contracts";
import type { RemoteBackendRelayLease } from "@bigbud/contracts/server/remoteBackendRelay.ts";
import { setBackendStorageIdentity } from "~/lib/backendScopedStorage";
import { randomUUID } from "~/lib/utils";
import { leaseHttpEndpoint } from "./backendScope.endpoint";
import {
  createRelayLeaseEndpoint,
  openLocalRelayControl,
  type RelayControl,
} from "./backendScope.relay";
import {
  isValidBackendProfileId,
  readBackendScope,
  readRequestedBackendProfile,
  setBackendScope,
  type BackendScopeState,
  type BoundBackendHttpEndpoint,
} from "./backendScope.state";
import { setOrchestrationDeliveryLifecycle } from "./orchestrationDeliveryState";
import { RemoteBackendClientRefused } from "./remoteBackendClientEndpoint";
import { openRemoteBackendClientOwner } from "./remoteBackendClientOwner";
import { localWsTransportScope } from "./wsTransport.scope";

type CursorStorage = Parameters<typeof openRemoteBackendClientOwner>[0]["cursorStorage"];

export interface BackendScopeDeps {
  readonly search: string;
  readonly openRelayControl: () => RelayControl;
  readonly openOwner: typeof openRemoteBackendClientOwner;
  readonly fetch: typeof fetch;
  readonly randomId: () => string;
  readonly cursorStorage: () => CursorStorage;
  readonly onDeliveryLifecycle: (event: OrchestrationDeliveryLifecycle) => void;
  /** Lets the desktop shell attach the lease credential to tag-loaded assets (img, iframe). */
  readonly bindAssets: (lease: RemoteBackendRelayLease) => void;
  readonly onUnload: (dispose: () => void) => void;
}

function defaultDeps(): BackendScopeDeps {
  return {
    search: window.location.search,
    openRelayControl: openLocalRelayControl,
    openOwner: openRemoteBackendClientOwner,
    fetch: (...args) => fetch(...args),
    randomId: randomUUID,
    cursorStorage: () => ({ session: sessionStorage, local: localStorage, randomId: randomUUID }),
    onDeliveryLifecycle: setOrchestrationDeliveryLifecycle,
    bindAssets: (lease) => {
      void window.desktopBridge
        ?.bindRemoteBackendAssets?.({
          baseUrl: lease.baseUrl,
          localCredential: lease.localCredential,
        })
        .catch(() => undefined);
    },
    onUnload: (dispose) => window.addEventListener("pagehide", dispose, { once: true }),
  };
}

/** Transport observers feed this window's own connection UI; the URL always comes from the
 * pinned owner, never from the local desktop bridge. */
function boundObservers(dispose: () => void) {
  const { resolveUrl: _localUrl, dispose: _localDispose, ...observers } = localWsTransportScope;
  return { ...observers, dispose };
}

/** Binds this window before first render. Without `?backend=` it returns immediately and the
 * local singletons behave exactly as before. A bound window never constructs them. */
export async function bootstrapBackendScope(
  overrides: Partial<BackendScopeDeps> = {},
): Promise<BackendScopeState> {
  const deps = { ...defaultDeps(), ...overrides };
  const profileId = readRequestedBackendProfile(deps.search);
  if (profileId === null) return readBackendScope();
  const settle = (next: BackendScopeState) => {
    setBackendScope(next);
    return next;
  };
  if (!isValidBackendProfileId(profileId))
    return settle({ kind: "unavailable", profileId, reason: "invalid-profile" });
  setBackendScope({ kind: "binding", profileId });

  const control = deps.openRelayControl();
  let listed: Awaited<ReturnType<RelayControl["relay"]["listRemoteBackendRelayProfiles"]>>;
  try {
    listed = await control.relay.listRemoteBackendRelayProfiles();
  } catch {
    await control.dispose();
    return settle({ kind: "unavailable", profileId, reason: "relay-failed" });
  }
  const profile = listed.profiles.find((entry) => entry.profileId === profileId);
  if (listed.availability !== "available" || !profile) {
    await control.dispose();
    const reason = listed.availability === "available" ? "not-found" : "setup-required";
    return settle({ kind: "unavailable", profileId, reason });
  }
  // Persisted stores key off the pinned identity (same as the scoped delivery cursor). This runs
  // before the first render; the owner refuses any server that does not match this pin.
  setBackendStorageIdentity(profile.identity);

  let http: BoundBackendHttpEndpoint | null = null;
  let handles: Awaited<ReturnType<typeof openRemoteBackendClientOwner>> | null = null;
  const publish = () => {
    if (http && handles && readBackendScope().kind !== "refused")
      setBackendScope(
        { kind: "bound", profileId, label: profile.label, http },
        { api: handles.api, rpcClient: handles.rpcClient },
      );
  };
  const lease = createRelayLeaseEndpoint({
    relay: control.relay,
    profileId,
    randomId: deps.randomId,
    fetch: deps.fetch,
    onLease: (opened) => {
      http = leaseHttpEndpoint(opened);
      deps.bindAssets(opened);
      publish();
    },
  });
  let teardown: Promise<void> | undefined;
  const releaseRelay = () => {
    teardown ??= lease.close().finally(() => control.dispose());
  };
  try {
    handles = await deps.openOwner({
      pin: profile.identity,
      resolveEndpoint: lease.resolve,
      signal: new AbortController().signal,
      scope: boundObservers(releaseRelay),
      cursorStorage: deps.cursorStorage(),
      onDeliveryLifecycle: deps.onDeliveryLifecycle,
      onAdmissionFailure: (refusal) => settle({ kind: "refused", profileId, refusal }),
    });
  } catch (error) {
    releaseRelay();
    if (error instanceof RemoteBackendClientRefused)
      return settle({ kind: "refused", profileId, refusal: error.status });
    return settle({ kind: "unavailable", profileId, reason: "relay-failed" });
  }
  const owner = handles;
  deps.onUnload(() => void owner.dispose().catch(() => undefined));
  publish();
  return readBackendScope();
}
