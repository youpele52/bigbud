import { Schema } from "effect";

import { IsoDateTime, ThreadId, TurnId } from "../core/baseSchemas";
import { ProviderKind } from "./orchestration.provider";

export const ProviderTurnInspectionState = Schema.Literals([
  "idle",
  "checking",
  "running",
  "waiting-for-user",
  "completed",
  "failed",
  "missing",
  "unavailable",
  "timed-out",
  "stalled",
  "recovering",
]);
export type ProviderTurnInspectionState = typeof ProviderTurnInspectionState.Type;

export const ProviderTurnLiveness = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  provider: ProviderKind,
  turnStartedAt: IsoDateTime,
  lastRuntimeEventAt: Schema.NullOr(IsoDateTime),
  lastMeaningfulProgressAt: IsoDateTime,
  lastInspectionAt: Schema.NullOr(IsoDateTime),
  inspectionStatus: ProviderTurnInspectionState,
  consecutiveInspectionFailures: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  terminalAt: Schema.NullOr(IsoDateTime),
});
export type ProviderTurnLiveness = typeof ProviderTurnLiveness.Type;
