import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import type { TurnId } from "@bigbud/contracts";
import { Effect, Option, Schema } from "effect";

import type { MuseAdapterShape } from "../../Services/Muse/Adapter.ts";
import {
  describeMuseError,
  isProvenNativeRefusal,
  museRequestError,
  museValidationError,
  mapMuseRequestError,
  mapMuseValidationError,
  getMuseFailureEvidence,
} from "./Client.errors.ts";
import { decodeTurnStart, MuseReasoningEffort } from "./Client.schema.ts";
import { museTurnFingerprint } from "./Adapter.admission.ts";
import type { MuseAdapterContext } from "./Adapter.types.ts";
import { encodeMuseCursor } from "./Adapter.cursor.ts";
import { switchMuseModel } from "./Adapter.model.ts";
import { validateMuseInteractionMode } from "./Adapter.session.ts";
import { setMuseActiveTurn } from "./Adapter.sessionView.ts";
import { advanceMuseJournal, settleMuseJournalTerminal } from "./Adapter.journal.ts";

/**
 * One foreground Muse turn: confirmed in-session model switch, durable
 * journal reserve/dispatch-intent before `turn/start`, genuine acceptance,
 * and proven-refusal settlement. See Adapter.admission.ts.
 */
export const makeMuseSendTurn = (ctx: MuseAdapterContext): MuseAdapterShape["sendTurn"] =>
  Effect.fn("Muse.sendTurn")(function* (input) {
    yield* ctx.requireUsable();
    const session = yield* ctx.getSession(input.threadId);
    yield* Effect.try({
      try: () => validateMuseInteractionMode(input.interactionMode),
      catch: (e) => mapMuseValidationError("sendTurn", e),
    });
    if (input.attachments && input.attachments.length > 0) {
      return yield* museValidationError(
        "sendTurn",
        "Muse Code does not accept attachments in bigbud yet.",
        "invalid-request",
      );
    }
    if (!input.input?.trim()) {
      return yield* museValidationError(
        "sendTurn",
        "Muse turn input is required.",
        "invalid-request",
      );
    }
    // Confirmed in-session model switch before a new turn (Adapter.model.ts).
    const requested = input.modelSelection?.provider === "muse" ? input.modelSelection : undefined;
    const effort = requested?.options?.reasoningEffort;
    if (effort !== undefined && !Schema.is(MuseReasoningEffort)(effort)) {
      return yield* museValidationError(
        "sendTurn",
        `Muse reasoning effort '${effort}' is not a native tier; choose one offered by the model catalog.`,
        "invalid-request",
      );
    }
    if (
      requested &&
      (!requested.model.trim() ||
        requested.model === "default" ||
        (requested.subProviderID && requested.subProviderID !== session.subProviderID))
    )
      return yield* museValidationError(
        "sendTurn",
        "Muse requires an explicit model in the current provider catalog.",
        "invalid-request",
      );
    if (requested && requested.model !== session.model) {
      yield* switchMuseModel({
        transport: session.transport,
        nativeSessionId: session.nativeSessionId,
        model: requested.model,
        providerId: session.subProviderID,
        operation: "sendTurn",
      });
      (session as { model: string }).model = requested.model;
    }
    const text = input.input;
    const cid = session.transport.mintCommandId();
    const lifecycle = {
      observed: new Map<string, "started" | "completed" | "failed" | "interrupted">(),
      overflow: false,
    };
    session.inFlightStarts?.set(cid, lifecycle);
    return yield* Effect.gen(function* () {
      // Durable foreground journal: reserve + dispatch-intent before calling
      // turn/start, with the pre-minted command ID as both admission and turn
      // identity (native turnId derives from commandId). Only an authoritative
      // typed refusal may settle dispatch-intent -> terminal/failed.
      let journalRow: ProviderTurnAdmission | undefined;
      if (ctx.deps.admissions && input.requestMessageId) {
        const now = new Date().toISOString();
        const reserved = yield* ctx.deps.admissions
          .reserve({
            namespace: "foreground",
            ownerThreadId: input.threadId,
            requestMessageId: input.requestMessageId,
            binding: {
              provider: "muse",
              threadId: input.threadId,
              nativeSessionId: session.nativeSessionId,
              location: session.workspace,
              runtimeTargetId: "local",
              workspaceTargetId: "local",
              storageIdentity: session.transport.initializeResult.museHome ?? "muse-home",
            },
            fingerprint: museTurnFingerprint({
              text,
              model: session.model,
              ...(effort ? { effort } : {}),
              runtimeMode: session.runtimeMode,
              nativeSessionId: session.nativeSessionId,
            }),
            nativeAdmissionId: cid,
            turnId: cid as TurnId,
            createdAt: now,
          })
          .pipe(
            Effect.mapError((e) =>
              mapMuseRequestError("admissions.reserve", e, "unsafe-to-replay"),
            ),
          );
        journalRow = yield* ctx.deps.admissions
          .transition(reserved, "dispatch-intent", now)
          .pipe(
            Effect.mapError((e) =>
              mapMuseRequestError("admissions.transition", e, "unsafe-to-replay"),
            ),
          );
        session.journalTurns.set(cid, journalRow);
      }
      const ackResult = yield* Effect.tryPromise({
        try: () =>
          session.transport.command(
            "turn/start",
            {
              commandId: cid,
              sessionId: session.nativeSessionId,
              input: [{ type: "text", text }],
              ...(effort ? { reasoningEffort: effort } : {}),
            },
            cid,
          ),
        catch: (error) => mapMuseRequestError("turn/start", error, "unsafe-to-replay"),
      }).pipe(Effect.result);
      if (ackResult._tag === "Failure") {
        const error = getMuseFailureEvidence(ackResult.failure);
        const proven = isProvenNativeRefusal(error);
        if (proven && ctx.deps.admissions && journalRow) {
          yield* advanceMuseJournal(ctx.deps.admissions, journalRow, "refused");
          session.journalTurns.delete(cid);
        }
        return yield* proven
          ? museRequestError(
              "turn/start",
              `Muse refused the turn: ${describeMuseError(error)}`,
              "invalid-request",
              error,
            )
          : mapMuseRequestError("turn/start", error, "unsafe-to-replay");
      }
      const ackRaw = ackResult.success;
      const ack = decodeTurnStart(ackRaw);
      if (
        Option.isNone(ack) ||
        ack.value.status !== "accepted" ||
        ack.value.commandId !== cid ||
        !ack.value.turnId.trim()
      ) {
        return yield* museRequestError(
          "turn/start",
          "Muse turn/start acknowledgement could not be decoded.",
          "unsafe-to-replay",
        );
      }
      if (ctx.deps.admissions && journalRow) {
        let accepted = yield* advanceMuseJournal(ctx.deps.admissions, journalRow, "accepted");
        const terminal = lifecycle.observed.get(ack.value.turnId);
        if (terminal && terminal !== "started")
          accepted = yield* settleMuseJournalTerminal(ctx.deps.admissions, accepted, terminal);
        if (accepted.state !== "terminal") session.journalTurns.set(ack.value.turnId, accepted);
        else session.journalTurns.delete(ack.value.turnId);
        if (ack.value.turnId !== cid) session.journalTurns.delete(cid);
      }
      if (session.closed || lifecycle.overflow)
        return yield* museRequestError(
          "turn/start",
          "Muse lifecycle evidence became unavailable before acknowledgement.",
          "unsafe-to-replay",
        );
      const observed = lifecycle.observed.get(ack.value.turnId);
      const settled = observed !== undefined && observed !== "started";
      if (ack.value.disposition === "queued" && !observed) {
        session.queuedTurns.set(ack.value.turnId, { commandId: ack.value.commandId });
      } else if (ack.value.disposition !== "started" && ack.value.disposition !== "queued") {
        return yield* museRequestError(
          "turn/start",
          `Muse returned unsupported turn disposition '${ack.value.disposition}'.`,
          "unsafe-to-replay",
        );
      }
      if (ack.value.disposition === "queued" && !observed)
        session.updatedAt = new Date().toISOString();
      else if (!settled && session.lastSettledTurnId !== ack.value.turnId)
        setMuseActiveTurn(session, ack.value.turnId as TurnId);
      return {
        threadId: input.threadId,
        turnId: ack.value.turnId as TurnId,
        resumeCursor: encodeMuseCursor({
          version: 1,
          provider: "muse",
          nativeSessionId: session.nativeSessionId,
          workspace: session.workspace,
          storageIdentity: session.transport.initializeResult.museHome ?? "",
          model: session.model,
          subProviderID: session.subProviderID,
        }),
      };
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          session.inFlightStarts?.delete(cid);
        }),
      ),
    );
  });
