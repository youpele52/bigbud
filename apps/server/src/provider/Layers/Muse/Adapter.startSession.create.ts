import type { ThreadId } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { MuseSessionBinding } from "../../../persistence/Services/MuseSessionBindings.ts";
import type { ProviderAdapterError } from "../../Errors.ts";
import type { MuseTransport } from "./Client.ts";
import type { MuseAdapterDeps, MuseBridgeHandle } from "./Adapter.types.ts";
import {
  describeMuseError,
  isMuseCreationAlreadyApplied,
  mapMuseRequestError,
  museRequestError,
  museValidationError,
  getMuseFailureEvidence,
} from "./Client.errors.ts";
import { decodeSessionStart } from "./Client.schema.ts";
import { museNativeWorkspaceRoot } from "./Client.platform.ts";
import { buildMuseSessionConfig } from "./Adapter.mcp.ts";
import { selectionFingerprint, type validateMuseStart } from "./Adapter.session.ts";

/** Durable exact-ID creation: binding persistence is part of success, never best-effort. */
export const createMuseSession = Effect.fn("Muse.createSession")(function* (input: {
  readonly deps: MuseAdapterDeps;
  readonly transport: MuseTransport;
  readonly threadId: ThreadId;
  readonly workspace: string;
  readonly storageIdentity: string;
  readonly binding: MuseSessionBinding | undefined;
  readonly validated: ReturnType<typeof validateMuseStart>;
  readonly acquireBridge: (
    nativeId: string,
  ) => Effect.Effect<MuseBridgeHandle, ProviderAdapterError>;
}) {
  const { deps, transport, validated, workspace } = input;
  let reserved = input.binding;
  const mintedSessionId = transport.mintCommandId();
  const creationCommandId = transport.mintCommandId();
  if (deps.bindings && !reserved) {
    reserved = yield* deps.bindings
      .reserve({
        threadId: input.threadId,
        nativeSessionId: mintedSessionId,
        creationCommandId,
        workspace,
        storageIdentity: input.storageIdentity,
        selectionFingerprint: selectionFingerprint({
          model: validated.model,
          subProviderID: validated.subProviderID,
          selection: validated.selection,
        }),
        createdAt: new Date().toISOString(),
      })
      .pipe(
        Effect.mapError((cause) =>
          mapMuseRequestError("bindings.reserve", cause, "unsafe-to-replay"),
        ),
      );
  }
  const createId = reserved?.nativeSessionId ?? mintedSessionId;
  const bridge = deps.bridgeFactory ? yield* input.acquireBridge(createId) : undefined;
  const cid = reserved?.creationCommandId ?? creationCommandId;
  const result = yield* Effect.tryPromise({
    try: () =>
      transport.command(
        "session/start",
        {
          commandId: cid,
          sessionId: createId,
          workspaceRoots: [museNativeWorkspaceRoot(workspace)],
          modelId: validated.model,
          permissionProfile: validated.selection.permissionProfile,
          approvalMode: validated.selection.approvalMode,
          ...buildMuseSessionConfig(bridge),
        },
        cid,
      ),
    catch: (cause) => mapMuseRequestError("session/start", cause, "unsafe-to-replay"),
  }).pipe(Effect.result);
  if (result._tag === "Failure") {
    const uncertainty = getMuseFailureEvidence(result.failure);
    if (reserved?.phase === "reserved" && isMuseCreationAlreadyApplied(uncertainty)) {
      if (deps.bindings)
        yield* deps.bindings
          .transition(reserved, "bound")
          .pipe(
            Effect.mapError((cause) =>
              mapMuseRequestError("bindings.bound", cause, "unsafe-to-replay"),
            ),
          );
      return { bridge, nativeSessionId: createId, mustResume: true };
    }
    if (deps.bindings && reserved)
      yield* deps.bindings
        .transition(reserved, "blocked")
        .pipe(
          Effect.mapError((cause) =>
            museRequestError(
              "bindings.blocked",
              `Could not durably block uncertain creation: ${describeMuseError(cause)}; original uncertainty: ${describeMuseError(uncertainty)}`,
              "unsafe-to-replay",
              { persistence: cause, uncertainty },
            ),
          ),
        );
    return yield* result.failure;
  }
  const started = decodeSessionStart(result.success);
  if (Option.isNone(started) || started.value.session.sessionId !== createId) {
    if (deps.bindings && reserved)
      yield* deps.bindings
        .transition(reserved, "blocked")
        .pipe(
          Effect.mapError((cause) =>
            museRequestError(
              "bindings.blocked",
              `Could not durably block unconfirmed native creation: ${describeMuseError(cause)}`,
              "unsafe-to-replay",
              cause,
            ),
          ),
        );
    return yield* museValidationError(
      "startSession",
      "Muse session/start did not confirm the pre-minted native session ID.",
      "unsafe-to-replay",
    );
  }
  if (deps.bindings && reserved?.phase === "reserved")
    yield* deps.bindings
      .transition(reserved, "bound")
      .pipe(
        Effect.mapError((cause) =>
          mapMuseRequestError("bindings.bound", cause, "unsafe-to-replay"),
        ),
      );
  return { bridge, nativeSessionId: createId, mustResume: false };
});
