/**
 * Pure permission narrowing for P8 peer grants and dispatches (WP-8A). A grant ceiling must be
 * narrower than or equal to the worker's local policy, and a dispatch's permissions narrower than
 * or equal to both the grant ceiling and the coordinator caller's own permissions.
 *
 * @module peerPermission.narrowing
 */
import {
  PEER_RUNTIME_MODE_ORDER,
  type PeerAction,
  type PeerGrant,
  type PeerPermissionCeiling,
} from "@bigbud/contracts/server/remotePeer.ts";

export type PeerPermissionViolation =
  | { readonly kind: "runtime-mode"; readonly requested: string; readonly ceiling: string }
  | { readonly kind: "provider"; readonly provider: string }
  | { readonly kind: "workspace"; readonly workspaceRoot: string };

const rank = (mode: PeerPermissionCeiling["runtimeMode"]): number =>
  PEER_RUNTIME_MODE_ORDER.indexOf(mode);

/** Every way `requested` exceeds `ceiling`; empty means it is within the ceiling. */
export function findPeerPermissionViolations(
  requested: PeerPermissionCeiling,
  ceiling: PeerPermissionCeiling,
): ReadonlyArray<PeerPermissionViolation> {
  const violations: PeerPermissionViolation[] = [];
  if (rank(requested.runtimeMode) > rank(ceiling.runtimeMode))
    violations.push({
      kind: "runtime-mode",
      requested: requested.runtimeMode,
      ceiling: ceiling.runtimeMode,
    });
  const providers = new Set(ceiling.providers);
  for (const provider of requested.providers)
    if (!providers.has(provider)) violations.push({ kind: "provider", provider });
  const roots = new Set(ceiling.workspaceRoots);
  for (const workspaceRoot of requested.workspaceRoots)
    if (!roots.has(workspaceRoot)) violations.push({ kind: "workspace", workspaceRoot });
  return violations;
}

export const isWithinPeerPermissionCeiling = (
  requested: PeerPermissionCeiling,
  ceiling: PeerPermissionCeiling,
): boolean => findPeerPermissionViolations(requested, ceiling).length === 0;

/**
 * The narrowest common permissions of two sets (for example a grant ceiling and the coordinator
 * caller's own permissions), or undefined when no provider or workspace remains.
 */
export function intersectPeerPermissions(
  a: PeerPermissionCeiling,
  b: PeerPermissionCeiling,
): PeerPermissionCeiling | undefined {
  const providers = a.providers.filter((provider) => b.providers.includes(provider));
  const workspaceRoots = a.workspaceRoots.filter((root) => b.workspaceRoots.includes(root));
  if (providers.length === 0 || workspaceRoots.length === 0) return undefined;
  return {
    runtimeMode: rank(a.runtimeMode) <= rank(b.runtimeMode) ? a.runtimeMode : b.runtimeMode,
    providers,
    workspaceRoots,
  };
}

export type PeerGrantDecision =
  | { readonly _tag: "allowed" }
  | {
      readonly _tag: "denied";
      readonly code:
        | "grant-expired"
        | "grant-revoked"
        | "authority-mismatch"
        | "action-not-allowed"
        | "permission-exceeds-ceiling";
      readonly violations: ReadonlyArray<PeerPermissionViolation>;
    };

type PeerGrantDenyCode = Extract<PeerGrantDecision, { _tag: "denied" }>["code"];
const deny = (
  code: PeerGrantDenyCode,
  violations: ReadonlyArray<PeerPermissionViolation> = [],
): PeerGrantDecision => ({ _tag: "denied", code, violations });

/** Worker-side admission of one peer action under a stored grant; deny reasons are typed. */
export function evaluatePeerGrant(input: {
  readonly grant: PeerGrant;
  readonly coordinatorAuthorityId: string;
  readonly coordinatorKeyFingerprint: string;
  readonly action: PeerAction;
  readonly requested?: PeerPermissionCeiling | undefined;
  readonly nowMs: number;
}): PeerGrantDecision {
  const { grant } = input;
  if (grant.revokedAt !== null) return deny("grant-revoked");
  const expiresAtMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtMs) || input.nowMs >= expiresAtMs) return deny("grant-expired");
  if (
    grant.coordinatorAuthorityId !== input.coordinatorAuthorityId ||
    grant.coordinatorKeyFingerprint !== input.coordinatorKeyFingerprint
  )
    return deny("authority-mismatch");
  if (!grant.actions.includes(input.action)) return deny("action-not-allowed");
  if (input.requested !== undefined) {
    const violations = findPeerPermissionViolations(input.requested, grant.ceiling);
    if (violations.length > 0) return deny("permission-exceeds-ceiling", violations);
  }
  return { _tag: "allowed" };
}
