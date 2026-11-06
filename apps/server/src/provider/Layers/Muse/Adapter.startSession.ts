import type { ProviderRuntimeEvent, ProviderSession, TurnId } from "@bigbud/contracts";
import { Effect, Ref } from "effect";

import type { MuseAdapterContext, MuseBridgeHandle } from "./Adapter.types.ts";
import { assertMuseHostQualified } from "./Client.ts";
import {
  museRequestError,
  museValidationError,
  mapMuseRequestError,
  mapMuseValidationError,
} from "./Client.errors.ts";
import { makeMuseHostCallbacks } from "./Adapter.startSession.callbacks.ts";
import { switchMuseModel } from "./Adapter.model.ts";
import { resumeMuseSession } from "./Adapter.startSession.resume.ts";
import { museProviderSession, stampMuseEvent } from "./Adapter.sessionView.ts";
import type { MuseSessionState } from "./Adapter.types.ts";
import { decodeMuseCursor, encodeMuseCursor } from "./Adapter.cursor.ts";
import { assertMuseAuthLane, resolveMuseWorkspace, validateMuseStart } from "./Adapter.session.ts";
import type { MuseHostFactory } from "./Client.ts";
import { makeMuseStartupOwner } from "./Adapter.resources.ts";
import { createMuseSession } from "./Adapter.startSession.create.ts";

/** Owns native session creation/resume, durable binding reservation and MCP injection. */
export function makeMuseStartSession(ctx: MuseAdapterContext) {
  const { deps, sessionsRef, publish } = ctx;
  return Effect.fn("Muse.startSession")(function* (
    input: Parameters<import("../../Services/Muse/Adapter.ts").MuseAdapterShape["startSession"]>[0],
  ) {
    const settings = yield* ctx.requireUsable();
    const validated = yield* Effect.try({
      try: () => validateMuseStart(input),
      catch: (error) => mapMuseValidationError("startSession", error),
    });
    const workspace = input.cwd ? yield* resolveMuseWorkspace(input.cwd) : undefined;
    if (!workspace) {
      return yield* museValidationError(
        "startSession",
        "Muse requires a local workspace cwd.",
        "invalid-request",
      );
    }
    const existing = (yield* Ref.get(sessionsRef)).get(input.threadId);
    if (existing && !existing.closed) {
      return yield* museValidationError(
        "startSession",
        "Muse session already active for this thread.",
        "invalid-request",
      );
    }
    const cursor =
      input.resumeCursor !== undefined ? decodeMuseCursor(input.resumeCursor) : undefined;
    if (input.resumeCursor !== undefined && !cursor) {
      return yield* museValidationError(
        "startSession",
        "Muse resume cursor is malformed or version-mismatched; no replacement session was created.",
        "invalid-request",
      );
    }
    if (
      cursor &&
      deps.bindings?.isArchived &&
      (yield* deps.bindings
        .isArchived(input.threadId, cursor.nativeSessionId)
        .pipe(
          Effect.mapError((e) => mapMuseRequestError("bindings.isArchived", e, "unsafe-to-replay")),
        ))
    ) {
      return yield* museValidationError(
        "startSession",
        "This Muse native context was archived when the project folder changed. Start fresh with the current explicit provider/model selection; the old session remains a recovery copy.",
        "unsafe-to-replay",
      );
    }
    const binding = deps.bindings
      ? yield* deps.bindings
          .find(input.threadId)
          .pipe(Effect.mapError((e) => mapMuseRequestError("bindings.find", e, "unsafe-to-replay")))
      : undefined;
    if (binding?.phase === "blocked") {
      return yield* museValidationError(
        "startSession",
        "Muse session creation for this thread is blocked after an uncertain native start; explicit recovery is required and no replacement session was created.",
        "unsafe-to-replay",
      );
    }
    if (cursor && binding && binding.nativeSessionId !== cursor.nativeSessionId) {
      return yield* museValidationError(
        "startSession",
        "Muse cursor does not match the durable session binding; refusing to resume a different native session.",
        "unsafe-to-replay",
      );
    }

    let bridge: MuseBridgeHandle | undefined;
    let transport: Awaited<ReturnType<MuseHostFactory>> | undefined;
    let state: MuseSessionState | undefined;
    let resumedActive: string | null = null;
    let resumedQueue: ReadonlyArray<{ readonly turnId: string; readonly commandId: string }> = [];
    let hasUnidentifiedQueuedInputs = false;
    let hostFailure: unknown;
    const owner = makeMuseStartupOwner();
    const recoveryEvents: Array<ProviderRuntimeEvent> = [];
    let recoveryScanRows: ReadonlyArray<
      import("@bigbud/contracts/orchestration/providerTurnAdmission.ts").ProviderTurnAdmission
    > = [];
    const sessionEpoch = input.sessionEpoch ?? 0;
    const stamped = (event: ProviderRuntimeEvent) => publish(stampMuseEvent(event, sessionEpoch));
    const emit = (event: ProviderRuntimeEvent) => Effect.runFork(stamped(event));
    const callbacks = makeMuseHostCallbacks({
      threadId: input.threadId,
      admissions: deps.admissions,
      getState: () => state,
      emit,
      ...(deps.usageObservations ? { observations: deps.usageObservations } : {}),
    });
    const onExit = (cause: unknown) => {
      hostFailure = mapMuseRequestError("host.exit", cause, "provider-unavailable");
      callbacks.fail(hostFailure);
      if (!state || state.closed) return;
      state.closed = true;
      const owned = state;
      Effect.runFork(
        Effect.gen(function* () {
          yield* Ref.update(sessionsRef, (sessions) => {
            const next = new Map(sessions);
            if (next.get(input.threadId) === owned) next.delete(input.threadId);
            return next;
          });
          yield* stamped({
            eventId: `muse-session-exit-${owned.nativeSessionId}`,
            provider: "muse",
            threadId: input.threadId,
            createdAt: new Date().toISOString(),
            type: "session.exited",
            payload: { reason: "Muse host connection lost.", recoverable: true },
          } as ProviderRuntimeEvent);
          yield* Effect.promise(() => owner.cleanup());
        }),
      );
    };
    const acquireBridge = (nativeId: string) =>
      owner.acquire(
        "bridge.acquire",
        () => Effect.runPromise(deps.bridgeFactory!(input.threadId, nativeId)),
        (value) => value.cleanup(),
      );
    const work = Effect.gen(function* () {
      transport = yield* owner.acquire(
        "spawn",
        () =>
          deps.hostFactory({
            binaryPath: settings.binaryPath,
            cwd: workspace,
            signal: owner.signal,
            onExit,
            onNotification: callbacks.onNotification,
            onServerRequest: callbacks.onServerRequest,
          }),
        (value) => value.close(),
      );
      transport.onExit?.(onExit);
      const gate = assertMuseHostQualified(transport);
      if (gate) return yield* museValidationError("startSession", gate, "provider-unavailable");
      yield* assertMuseAuthLane(transport);
      const storageIdentity = transport.initializeResult.museHome ?? settings.binaryPath;
      let nativeSessionId: string | undefined;
      // A confirmed (bound) session is always resumed by its exact ID, even
      // when the caller sends no cursor (fresh restarts, lost cursors):
      // replaying session/start with the stored command ID can never succeed,
      // because the payload carries per-launch details such as the MCP bridge.
      let resumeTarget =
        cursor ??
        (binding?.phase === "bound"
          ? { nativeSessionId: binding.nativeSessionId, workspace: binding.workspace }
          : undefined);
      if (!resumeTarget) {
        const created = yield* createMuseSession({
          deps,
          transport,
          threadId: input.threadId,
          workspace,
          storageIdentity,
          binding,
          validated,
          acquireBridge,
        });
        bridge = created.bridge;
        nativeSessionId = created.nativeSessionId;
        if (created.mustResume) resumeTarget = { nativeSessionId, workspace };
      }
      if (resumeTarget) {
        nativeSessionId = resumeTarget.nativeSessionId;
        if (
          resumeTarget.workspace !== workspace &&
          (yield* resolveMuseWorkspace(resumeTarget.workspace)) !== workspace
        ) {
          return yield* museValidationError(
            "startSession",
            "Muse session workspace does not match this thread's workspace.",
            "unsafe-to-replay",
          );
        }
        bridge ??= deps.bridgeFactory ? yield* acquireBridge(nativeSessionId) : undefined;
        const resumed = yield* resumeMuseSession({
          deps,
          transport,
          threadId: input.threadId,
          nativeSessionId,
          bridge,
        });
        recoveryEvents.push(...resumed.recoveryEvents);
        recoveryScanRows = resumed.recoveryScanRows;
        resumedActive = resumed.activeTurnId;
        resumedQueue = resumed.queuedTurns;
        hasUnidentifiedQueuedInputs = resumed.hasUnidentifiedQueuedInputs;
        // The thread's selected model wins over the session's standing one.
        if (resumed.nativeModelId && resumed.nativeModelId !== validated.model) {
          yield* switchMuseModel({
            transport,
            nativeSessionId,
            model: validated.model,
            providerId: validated.subProviderID,
            operation: "startSession",
          });
        }
      }
      if (!nativeSessionId) {
        return yield* museValidationError(
          "startSession",
          "Muse session identity was not established; no session was created.",
          "unsafe-to-replay",
        );
      }

      if (hostFailure)
        return yield* mapMuseRequestError("host.exit", hostFailure, "provider-unavailable");
      state = {
        threadId: input.threadId,
        transport,
        nativeSessionId,
        workspace,
        model: validated.model,
        subProviderID: validated.subProviderID,
        runtimeMode: input.runtimeMode,
        sessionEpoch,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        activeTurnId: resumedActive ? (resumedActive as TurnId) : undefined,
        lastSettledTurnId: undefined,
        items: new Map(),
        queuedTurns: new Map(
          resumedQueue.map((entry) => [entry.turnId, { commandId: entry.commandId }]),
        ),
        hasUnidentifiedQueuedInputs,
        inFlightStarts: new Map(),
        journalTurns: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        cleanupBridge: bridge ? bridge.cleanup : async () => undefined,
        closed: false,
      };
      const finalState = state;
      // Seed unresolved recovery rows so live terminal/reclaim notifications
      // settle them through the normal journal path after this resume.
      for (const row of recoveryScanRows) {
        if (row.state !== "terminal") finalState.journalTurns.set(row.turnId, row);
      }
      yield* Ref.update(sessionsRef, (sessions) =>
        new Map(sessions).set(input.threadId, finalState),
      );
      yield* stamped({
        eventId: `muse-session-${nativeSessionId}`,
        provider: "muse",
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
        type: "session.started",
        payload: {},
      } as ProviderRuntimeEvent);
      yield* Effect.tryPromise({
        try: () => callbacks.activate(recoveryEvents),
        catch: (cause) => mapMuseRequestError("startupCallbacks", cause, "unsafe-to-replay"),
      });
      if (state.closed || hostFailure)
        return yield* mapMuseRequestError("host.exit", hostFailure, "provider-unavailable");
      return {
        ...museProviderSession(finalState),
        resumeCursor: encodeMuseCursor({
          version: 1,
          provider: "muse",
          nativeSessionId,
          workspace,
          storageIdentity,
          model: validated.model,
          subProviderID: validated.subProviderID,
        }),
      } satisfies ProviderSession;
    });
    return yield* work.pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.gen(function* () {
              callbacks.fail(
                museRequestError(
                  "startup",
                  "Muse startup failed or was interrupted.",
                  "unsafe-to-replay",
                ),
              );
              if (state) state.closed = true;
              yield* Ref.update(sessionsRef, (sessions) => {
                const next = new Map(sessions);
                if (state && next.get(input.threadId) === state) next.delete(input.threadId);
                return next;
              });
              yield* Effect.promise(() => owner.cleanup());
            }),
      ),
    );
  });
}
