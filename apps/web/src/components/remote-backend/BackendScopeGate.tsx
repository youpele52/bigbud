import { useSyncExternalStore, type ReactNode } from "react";
import { readBackendScope, subscribeBackendScope } from "../../rpc/backendScope.state";
import { RemoteBackendWindowStatus } from "./RemoteBackendWindowStatus";

/** Renders the app for the local window and for a bound window with a live owner. A later
 * admission refusal (for example a key rotation on reconnect) replaces the app with guidance. */
export function BackendScopeGate({ children }: { readonly children: ReactNode }) {
  const state = useSyncExternalStore(subscribeBackendScope, readBackendScope, readBackendScope);
  if (state.kind === "local" || state.kind === "bound") return children;
  return <RemoteBackendWindowStatus state={state} />;
}
