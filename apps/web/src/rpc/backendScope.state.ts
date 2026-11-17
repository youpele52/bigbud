import type { NativeApi } from "@bigbud/contracts";
import { RemoteBackendRelayProfileId } from "@bigbud/contracts/server/remoteBackendRelay.ts";
import * as Schema from "effect/Schema";
import type { RemoteClientRefusal } from "./remoteBackendClientEndpoint";
import type { WsRpcClient } from "./wsRpcClient.types";

/** Query parameter that binds one renderer window to one remote backend (plan decision 2). */
export const BACKEND_SCOPE_QUERY_PARAM = "backend";

export type BackendScopeUnavailableReason =
  | "invalid-profile"
  | "setup-required"
  | "not-found"
  | "relay-failed";

export interface BoundBackendHttpEndpoint {
  /** Loopback relay lease origin, e.g. `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** Credential and revision headers every relay HTTP request must carry. */
  readonly headers: Readonly<Record<string, string>>;
}

export type BackendScopeState =
  | { readonly kind: "local" }
  | { readonly kind: "binding"; readonly profileId: string }
  | {
      readonly kind: "bound";
      readonly profileId: string;
      readonly label: string;
      readonly http: BoundBackendHttpEndpoint;
    }
  | {
      readonly kind: "unavailable";
      readonly profileId: string;
      readonly reason: BackendScopeUnavailableReason;
    }
  | { readonly kind: "refused"; readonly profileId: string; readonly refusal: RemoteClientRefusal };

interface BoundHandles {
  readonly api: NativeApi;
  readonly rpcClient: WsRpcClient;
}

const LOCAL: BackendScopeState = Object.freeze({ kind: "local" });
let state: BackendScopeState = LOCAL;
let handles: BoundHandles | null = null;
const listeners = new Set<() => void>();

/** Raw `?backend=` value of this window, or null for the local window. Never trusted as valid. */
export function readRequestedBackendProfile(
  search: string = typeof window === "undefined" ? "" : (window.location?.search ?? ""),
): string | null {
  const value = new URLSearchParams(search).get(BACKEND_SCOPE_QUERY_PARAM);
  return value === null ? null : value;
}

export function isValidBackendProfileId(value: string): boolean {
  return Schema.is(RemoteBackendRelayProfileId)(value);
}

/** True for every window opened with `?backend=`, ready or not. Such a window never falls back to
 * the local backend singletons, even while binding or after a refusal. */
export function isBoundBackendWindow(): boolean {
  return state.kind !== "local" || readRequestedBackendProfile() !== null;
}

export function readBackendScope(): BackendScopeState {
  return state;
}

export function subscribeBackendScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setBackendScope(next: BackendScopeState, bound?: BoundHandles): void {
  state = next;
  handles = next.kind === "bound" && bound ? bound : null;
  for (const listener of listeners) listener();
}

export class BoundBackendNotReadyError extends Error {
  readonly _tag = "BoundBackendNotReadyError";
  constructor() {
    super("This window is bound to a remote backend that is not connected.");
    this.name = "BoundBackendNotReadyError";
  }
}

/** `undefined` means "local window": the caller may use its local singleton. A bound window gets
 * its own client or a typed error, never the local fallback. */
export function resolveBoundWsRpcClient(): WsRpcClient | undefined {
  if (!isBoundBackendWindow()) return undefined;
  if (!handles) throw new BoundBackendNotReadyError();
  return handles.rpcClient;
}

export function readBoundNativeApi(): NativeApi | undefined {
  return handles?.api;
}

export function readBoundHttpEndpoint(): BoundBackendHttpEndpoint | null {
  return state.kind === "bound" ? state.http : null;
}

export function __resetBackendScopeForTests(): void {
  state = LOCAL;
  handles = null;
  listeners.clear();
}
