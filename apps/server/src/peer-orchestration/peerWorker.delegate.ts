/**
 * Worker-side `delegate` (WP-8B). Maps one peer dispatch identity onto the same orchestration
 * commands `create_thread` uses (`thread.create` then `thread.turn.start`), with the
 * coordinator-namespaced command id. The `peer_children` record fixes the child id, creation
 * time and start intent, so a repeated delegate dispatches byte-identical commands and command
 * receipts return the first result: one dispatch identity never creates a second child. The
 * start itself completes in `peerWorker.start`, independently of this request (F-P8-3).
 *
 * @module peerWorker.delegate
 */
import { createHash } from "node:crypto";

import { ModelSelection } from "@bigbud/contracts";
import { DEFAULT_MODEL_BY_PROVIDER } from "@bigbud/contracts/constants/model.constant.ts";
import type { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";
import type {
  PeerDelegateRequest,
  PeerDelegateResponse,
} from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Effect, Schema } from "effect";

import { ensureOrchestrationWorkspaceProjects } from "../orchestration/Services/OrchestrationEngine.ts";
import { stableThreadToolId } from "../orchestration-tools/ThreadOrchestrationTools.origins.ts";
import type { PeerChildStart } from "../persistence/Services/PeerChildren.ts";
import { isWithinPeerPermissionCeiling } from "./peerPermission.narrowing.ts";
import { peerWorkerChildStatus, type PeerWorkerDeps } from "./peerWorker.read.ts";
import { peerCommandId, PeerWorkerRefusal } from "./peerWorker.status.ts";

/** Canonical digest of the request; field order is fixed so identical retries match. */
export function peerDelegateDigest(request: PeerDelegateRequest): string {
  const canonical = [
    request.dispatchId,
    request.coordinatorThreadId,
    request.workspaceRoot,
    request.provider,
    request.model ?? null,
    request.permissions.runtimeMode,
    request.permissions.providers,
    request.permissions.workspaceRoots,
    request.title,
    request.task,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const internal = (message: string) => PeerWorkerRefusal.of("child-failed", message);
/**
 * The child's model: the requested one, else the worker project's default when it names the
 * same provider, else the provider default.
 */
export function resolvePeerChildModel(
  request: Pick<PeerDelegateRequest, "provider" | "model">,
  projectDefault: { readonly provider: string; readonly model: string } | null | undefined,
): string {
  if (request.model) return request.model;
  if (projectDefault && projectDefault.provider === request.provider && projectDefault.model)
    return projectDefault.model;
  return DEFAULT_MODEL_BY_PROVIDER[request.provider];
}

export const peerWorkerDelegate = Effect.fn("peerWorkerDelegate")(function* (
  deps: PeerWorkerDeps,
  grant: PeerGrant,
  request: PeerDelegateRequest,
) {
  const target = {
    runtimeMode: request.permissions.runtimeMode,
    providers: [request.provider],
    workspaceRoots: [request.workspaceRoot],
  };
  // Grant admission already bounded `permissions` by the ceiling; the target must sit inside both.
  if (
    !isWithinPeerPermissionCeiling(target, request.permissions) ||
    !isWithinPeerPermissionCeiling(target, grant.ceiling)
  )
    return yield* PeerWorkerRefusal.of(
      "permission-exceeds-ceiling",
      "The delegate target is outside the requested permissions.",
    );
  const commandId = peerCommandId(grant.coordinatorAuthorityId, request.dispatchId);
  // A repeated identity keeps the start intent recorded first (project and model included).
  const existing = yield* deps.children
    .findByCommand(commandId)
    .pipe(Effect.mapError(() => internal("The worker could not read the child record.")));
  const start = existing?.start ?? (yield* resolvePeerChildStart(deps, request));
  const { child, joined } = yield* deps.children
    .claim({
      commandId,
      dispatchId: request.dispatchId,
      coordinatorAuthorityId: grant.coordinatorAuthorityId,
      grantId: grant.grantId,
      childThreadId: stableThreadToolId("peer-thread", commandId),
      requestDigest: peerDelegateDigest(request),
      workspaceRoot: request.workspaceRoot,
      provider: request.provider,
      createdAt: new Date().toISOString(),
      start,
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "PeerChildConflict"
          ? PeerWorkerRefusal.of("dispatch-conflict", error.detail)
          : internal("The worker could not record the child."),
      ),
    );
  // The start runs in the starter's scope: a cut channel interrupts only this wait.
  yield* deps.starter.ensureStarted(child.commandId);
  const status = yield* peerWorkerChildStatus(deps, child.commandId).pipe(
    Effect.mapError(() => internal("The worker could not read the child.")),
  );
  if (!status) return yield* internal("The child is not visible after creation.");
  return { ...status, replayed: joined } as PeerDelegateResponse;
});

/** Project (hydrated when idle) and model for a new child; refuses an unknown workspace. */
const resolvePeerChildStart = Effect.fn("resolvePeerChildStart")(function* (
  deps: PeerWorkerDeps,
  request: PeerDelegateRequest,
) {
  const [project] = yield* ensureOrchestrationWorkspaceProjects(deps.engine, request.workspaceRoot);
  if (!project)
    return yield* PeerWorkerRefusal.of(
      "workspace-unavailable",
      "The worker has no project for the requested workspace root.",
    );
  const modelSelection = yield* Schema.decodeUnknownEffect(ModelSelection)({
    provider: request.provider,
    model: resolvePeerChildModel(request, project.defaultModelSelection),
  }).pipe(Effect.mapError(() => internal("The requested model selection is invalid.")));
  return {
    projectId: project.id,
    title: request.title,
    task: request.task,
    modelSelection: { provider: modelSelection.provider, model: modelSelection.model },
    runtimeMode: request.permissions.runtimeMode,
  } satisfies PeerChildStart;
});
