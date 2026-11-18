/**
 * Worker-side `delegate` (WP-8B). Maps one peer dispatch identity onto the same orchestration
 * commands `create_thread` uses (`thread.create` then `thread.turn.start`), with the
 * coordinator-namespaced command id. The `peer_children` record fixes the child id and creation
 * time, so a repeated delegate dispatches byte-identical commands and command receipts return the
 * first result: one dispatch identity never creates a second child.
 *
 * @module peerWorker.delegate
 */
import { createHash } from "node:crypto";

import {
  CommandId,
  MessageId,
  ModelSelection,
  ThreadId,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { DEFAULT_MODEL_BY_PROVIDER } from "@bigbud/contracts/constants/model.constant.ts";
import { DEFAULT_PROVIDER_INTERACTION_MODE } from "@bigbud/contracts/constants/runtime.constant.ts";
import type { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";
import type {
  PeerDelegateRequest,
  PeerDelegateResponse,
} from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Effect, Schema } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { stableThreadToolId } from "../orchestration-tools/ThreadOrchestrationTools.origins.ts";
import type { PeerChildRepositoryShape } from "../persistence/Services/PeerChildren.ts";
import { isWithinPeerPermissionCeiling } from "./peerPermission.narrowing.ts";
import { peerChildStatus, peerCommandId, PeerWorkerRefusal } from "./peerWorker.status.ts";

export interface PeerWorkerDeps {
  readonly engine: OrchestrationEngineShape;
  readonly children: PeerChildRepositoryShape;
}

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
const dispatchFailure = (error: { readonly _tag?: string }) =>
  error._tag === "OrchestrationCommandIdConflictError"
    ? PeerWorkerRefusal.of("dispatch-conflict", "The dispatch identity conflicts with a command.")
    : internal("The worker could not start the child.");

/** History-level thread state, falling back to the operational read model. */
export const loadPeerChildThread = Effect.fn("loadPeerChildThread")(function* (
  engine: OrchestrationEngineShape,
  childThreadId: string,
) {
  const id = ThreadId.makeUnsafe(childThreadId);
  if (engine.ensureThreadState) {
    const thread = yield* engine.ensureThreadState(id, "history");
    if (thread) return thread;
  }
  const readModel = yield* engine.getReadModel();
  return readModel.threads.find((thread) => thread.id === id) as OrchestrationThread | undefined;
});

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
  const readModel = yield* deps.engine.getReadModel();
  const project = readModel.projects.find(
    (entry) =>
      entry.workspaceRoot === request.workspaceRoot &&
      entry.deletedAt === null &&
      !entry.deletingAt,
  );
  if (!project)
    return yield* PeerWorkerRefusal.of(
      "workspace-unavailable",
      "The worker has no project for the requested workspace root.",
    );
  const modelSelection = yield* Schema.decodeUnknownEffect(ModelSelection)({
    provider: request.provider,
    model: request.model ?? DEFAULT_MODEL_BY_PROVIDER[request.provider],
  }).pipe(Effect.mapError(() => internal("The requested model selection is invalid.")));

  const commandId = peerCommandId(grant.coordinatorAuthorityId, request.dispatchId);
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
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "PeerChildConflict"
          ? PeerWorkerRefusal.of("dispatch-conflict", error.detail)
          : internal("The worker could not record the child."),
      ),
    );
  const threadId = ThreadId.makeUnsafe(child.childThreadId);
  const common = {
    runtimeMode: request.permissions.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: child.createdAt,
  } as const;
  // Both commands are pure functions of the stored record and the (digest-checked) request.
  yield* deps.engine
    .dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(child.commandId),
      threadId,
      projectId: project.id,
      title: request.title,
      purpose: "standard",
      modelSelection,
      branch: null,
      worktreePath: null,
      ...common,
    })
    .pipe(Effect.mapError(dispatchFailure));
  yield* deps.engine
    .dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(`${child.commandId}:turn`),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe(stableThreadToolId("peer-message", child.commandId)),
        role: "user",
        text: request.task,
        attachments: [],
      },
      modelSelection,
      ...common,
    })
    .pipe(Effect.mapError(dispatchFailure));
  const thread = yield* loadPeerChildThread(deps.engine, child.childThreadId);
  if (!thread) return yield* internal("The child thread is not visible after creation.");
  return { ...peerChildStatus(child, thread), replayed: joined } as PeerDelegateResponse;
});
