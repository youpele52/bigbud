/**
 * Coordinator side of `delegate_to_host` before anything is sent (WP-8D/8E): choose the active
 * pairing, narrow permissions (caller and grant ceiling), derive the idempotency key from the tool
 * invocation, and persist the `pending` dispatch plus its exact request. A retried tool call
 * joins the existing dispatch instead of creating a second identity.
 *
 * @module peerDispatch.delegate
 */
import { createHash } from "node:crypto";

import type { PeerDispatch, PeerError } from "@bigbud/contracts/server/remotePeer.ts";
import { PeerDelegateRequest } from "@bigbud/contracts/server/remotePeer.wire.ts";
import type { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { Effect, Schema } from "effect";

import { intersectPeerPermissions } from "../peer-orchestration/peerPermission.narrowing.ts";
import type { PeerCoordinatorDeps } from "./peerDispatch.deps.ts";

export interface PeerDelegateInput {
  readonly callerThreadId: string;
  readonly invocationId: string;
  readonly task: string;
  readonly title?: string | undefined;
  /** Pairing label, worker authority id or SSH host; required when several pairings exist. */
  readonly host?: string | undefined;
  readonly model?: string | undefined;
}

export type PeerDelegatePrepared =
  | { readonly _tag: "refused"; readonly unavailable: boolean; readonly error: PeerError }
  | {
      readonly _tag: "dispatch";
      readonly dispatch: PeerDispatch;
      readonly pairing: PeerPairing;
      readonly joined: boolean;
    };

const decodeRequest = Schema.decodeUnknownOption(PeerDelegateRequest);

export const isActivePairing = (pairing: PeerPairing) =>
  pairing.grantId !== null && pairing.grantRevokedAt === null;

/** `tool:<sha256(invocation id)>`: retries of one tool call join one dispatch identity. */
export const peerRequestKey = (invocationId: string) =>
  `tool:${createHash("sha256").update(invocationId).digest("hex")}`;

const refused = (code: PeerError["code"], message: string, unavailable = false) =>
  ({ _tag: "refused", unavailable, error: { code, message } }) as PeerDelegatePrepared;

export function selectPeerPairing(
  pairings: ReadonlyArray<PeerPairing>,
  host: string | undefined,
): PeerPairing | PeerDelegatePrepared {
  const active = pairings.filter(isActivePairing);
  if (active.length === 0)
    return refused(
      "grant-missing",
      "No worker host is paired with an active grant. Ask the user to pair a host in Settings.",
      true,
    );
  const wanted = host?.trim();
  if (!wanted) {
    if (active.length === 1) return active[0]!;
    return refused(
      "grant-missing",
      `Several hosts are paired; pass host as one of: ${active.map((p) => p.label).join(", ")}.`,
    );
  }
  const named = (p: PeerPairing) =>
    p.label === wanted || p.workerAuthorityId === wanted || p.host === wanted;
  const match = active.find(named);
  if (match) return match;
  // A known host without an active grant (revoked, or never granted) is unavailable (O-4).
  const inactive = pairings.find(named);
  if (inactive)
    return refused(
      inactive.grantRevokedAt !== null ? "grant-revoked" : "grant-missing",
      `Host ${inactive.label} has no active grant (${
        inactive.grantRevokedAt !== null ? "revoked" : "not granted yet"
      }); active hosts: ${active.map((p) => p.label).join(", ")}.`,
      true,
    );
  return refused(
    "grant-missing",
    `No active pairing named ${wanted}; paired hosts: ${active.map((p) => p.label).join(", ")}.`,
  );
}

export const preparePeerDelegate = Effect.fn("peerDispatch.prepareDelegate")(function* (
  deps: PeerCoordinatorDeps,
  input: PeerDelegateInput,
) {
  if (deps.coordinatorAuthorityId === null)
    return refused(
      "grant-missing",
      "Peer delegation is only available on a remote backend coordinator.",
      true,
    );
  const selected = selectPeerPairing(yield* deps.pairings.list(), input.host);
  if ("_tag" in selected) return selected;
  const pairing = selected;
  const ceiling = {
    runtimeMode: pairing.runtimeMode,
    providers: [pairing.provider],
    workspaceRoots: [pairing.workspaceRoot],
  };
  const callerMode = (yield* deps.callerRuntimeMode(input.callerThreadId)) ?? "approval-required";
  const permissions = intersectPeerPermissions({ ...ceiling, runtimeMode: callerMode }, ceiling);
  if (!permissions)
    return refused("permission-exceeds-ceiling", "No permissions remain after narrowing.");

  const requestKey = peerRequestKey(input.invocationId);
  const existing = yield* deps.dispatches.findByRequestKey(input.callerThreadId, requestKey);
  const dispatchId = existing?.dispatchId ?? deps.newDispatchId();
  const task = input.task.trim();
  const title = (input.title?.trim() || task.split("\n")[0]!.trim()).slice(0, 200);
  const request = decodeRequest({
    dispatchId,
    coordinatorThreadId: input.callerThreadId,
    workspaceRoot: pairing.workspaceRoot,
    provider: pairing.provider,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    permissions,
    title,
    task,
  });
  if (request._tag === "None")
    return refused("child-failed", "task is required (at most 32000 characters).");
  const now = deps.now();
  const inserted = yield* deps.dispatches
    .insert({
      dispatchId,
      commandId: `peer:${deps.coordinatorAuthorityId}:${dispatchId}`,
      coordinatorAuthorityId: deps.coordinatorAuthorityId,
      coordinatorThreadId: input.callerThreadId as PeerDispatch["coordinatorThreadId"],
      requestKey,
      worker: {
        workerAuthorityId: pairing.workerAuthorityId,
        grantId: pairing.grantId!,
        workspaceRoot: pairing.workspaceRoot,
        provider: pairing.provider,
      },
      permissions,
      state: "pending",
      sendAttempts: 0,
      childThreadId: null,
      cancelRequestedAt: null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    })
    .pipe(
      Effect.catchTag("PeerDispatchConflict", (error) =>
        Effect.succeed({ conflict: error.detail } as const),
      ),
    );
  if ("conflict" in inserted) return refused("dispatch-conflict", inserted.conflict);
  // The first request is kept: a joined retry never changes what the worker is sent.
  if (!inserted.joined) yield* deps.requests.save(request.value, now);
  return {
    _tag: "dispatch",
    dispatch: inserted.dispatch,
    pairing,
    joined: inserted.joined,
  } as PeerDelegatePrepared;
});
