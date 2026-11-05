import type { ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { Effect, Option } from "effect";

import { buildMuseSessionConfig } from "./Adapter.mcp.ts";
import {
  executeMuseRecovery,
  scanMuseJournal,
  type MuseNativeRecoveryEvidence,
} from "./Adapter.recovery.ts";
import { KNOWN_HISTORY_MODES } from "./Adapter.session.ts";
import type { MuseAdapterDeps, MuseBridgeHandle } from "./Adapter.types.ts";
import { mapMuseRequestError, museValidationError } from "./Client.errors.ts";
import type { MuseTransport } from "./Client.ts";
import { decodeSessionResume, decodeSessionRead, museSnapshotQueue } from "./Client.schema.ts";

export interface MuseResumeResult {
  /** The native session's standing model, when the host reports one. */
  readonly nativeModelId: string | null;
  readonly recoveryEvents: ReadonlyArray<ProviderRuntimeEvent>;
  readonly recoveryScanRows: ReadonlyArray<ProviderTurnAdmission>;
  readonly activeTurnId: string | null;
  readonly queuedTurns: ReadonlyArray<{ readonly turnId: string; readonly commandId: string }>;
  readonly hasUnidentifiedQueuedInputs: boolean;
}

/**
 * Exact-ID `session/resume` of an owned native session plus journal recovery.
 * Never creates a replacement: an unconfirmed or unknown-history resume fails.
 */
export const resumeMuseSession = Effect.fn("Muse.resumeSession")(function* (input: {
  readonly deps: MuseAdapterDeps;
  readonly transport: MuseTransport;
  readonly threadId: ThreadId;
  readonly nativeSessionId: string;
  readonly bridge: MuseBridgeHandle | undefined;
}) {
  const { deps, transport, nativeSessionId, bridge } = input;
  const recoveryEvents: Array<ProviderRuntimeEvent> = [];
  let recoveryScanRows: ReadonlyArray<ProviderTurnAdmission> = [];
  const cid = transport.mintCommandId();
  const resumedRaw = yield* Effect.tryPromise({
    try: () =>
      transport.command(
        "session/resume",
        {
          commandId: cid,
          sessionId: nativeSessionId,
          excludeItems: false,
          history: "snapshot",
          ...buildMuseSessionConfig(bridge),
        },
        cid,
      ),
    catch: (error) => mapMuseRequestError("session/resume", error, "unsafe-to-replay"),
  });
  const resumed = decodeSessionResume(resumedRaw);
  if (Option.isNone(resumed) || resumed.value.session.sessionId !== nativeSessionId) {
    return yield* museValidationError(
      "startSession",
      "Muse resume did not confirm the exact native session; no replacement session was created.",
      "unsafe-to-replay",
    );
  }
  if (!KNOWN_HISTORY_MODES.has(resumed.value.history.mode)) {
    return yield* museValidationError(
      "startSession",
      `Muse resume returned unknown history mode '${resumed.value.history.mode}'; refusing to treat it as empty history.`,
      "unsafe-to-replay",
    );
  }
  // Muse journal recovery (Phase 3.11/3.15): page the whole bound
  // journal, settle only rows with authoritative native terminal
  // evidence, and collect stable-ID terminal redelivery for rows
  // whose canonical outcome may never have been delivered. Uncertain
  // rows stay unresolved and are never resubmitted.
  const readOption = yield* Effect.tryPromise({
    try: () =>
      transport.request("session/read", { sessionId: nativeSessionId, excludeItems: false }),
    catch: (cause) => mapMuseRequestError("session/read", cause),
  }).pipe(Effect.option);
  const decodedRead = Option.isSome(readOption)
    ? decodeSessionRead(readOption.value)
    : Option.none();
  const read =
    Option.isSome(decodedRead) && decodedRead.value.session.sessionId === nativeSessionId
      ? decodedRead.value
      : undefined;
  const activeTurnId = read ? read.session.activeTurnId : resumed.value.session.activeTurnId;
  const resumeQueue = museSnapshotQueue(resumed.value);
  const queueEvidence =
    (read ? museSnapshotQueue(read) : undefined) ??
    (!read || read.viewCursor === resumed.value.viewCursor ? resumeQueue : undefined);
  const queuedTurns = queueEvidence ?? [];
  if (deps.admissions) {
    const evidence: MuseNativeRecoveryEvidence = {
      activeTurnId,
      queuedTurnIds: queuedTurns.map((entry) => entry.turnId),
      lastTurn: read ? (read.lastTurn ?? null) : (resumed.value.lastTurn ?? null),
    };
    const scan = yield* scanMuseJournal(deps.admissions, input.threadId).pipe(
      Effect.mapError((e) => mapMuseRequestError("admissions.scan", e, "unsafe-to-replay")),
    );
    yield* executeMuseRecovery({
      admissions: deps.admissions,
      threadId: input.threadId,
      scan,
      evidence,
      publish: (event) =>
        Effect.sync(() => {
          recoveryEvents.push(event);
        }),
    });
    recoveryScanRows = (yield* scanMuseJournal(deps.admissions, input.threadId)).rows.filter(
      (row) => row.state !== "terminal",
    );
  }
  return {
    nativeModelId: resumed.value.session.modelId,
    recoveryEvents,
    recoveryScanRows,
    activeTurnId,
    queuedTurns,
    hasUnidentifiedQueuedInputs:
      queueEvidence === undefined &&
      (!!read?.queuedInputs?.length ||
        !!resumeQueue?.some(
          (entry) => entry.turnId !== activeTurnId && entry.turnId !== read?.lastTurn?.turnId,
        ) ||
        recoveryScanRows.some((row) => row.state !== "reserved" && row.turnId !== activeTurnId)),
  } satisfies MuseResumeResult;
});
