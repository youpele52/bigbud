import * as Rpc from "effect/unstable/rpc/Rpc";
import { Schema } from "effect";
import { ServerProviderUpdatedPayload } from "./server";
import { SubscriptionRefreshOutcome } from "./usageLimits";

import { WS_METHODS } from "../constants/websocket.constant";
import { ServerGetUsageSummaryInput, ServerUsageError, ServerUsageSummaryResult } from "./usage";

export const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: ServerGetUsageSummaryInput,
  success: ServerUsageSummaryResult,
  error: ServerUsageError,
});

export const ServerRefreshUsageLimitsResult = Schema.Struct({
  ...ServerProviderUpdatedPayload.fields,
  outcomes: Schema.Array(SubscriptionRefreshOutcome),
});
export type ServerRefreshUsageLimitsResult = typeof ServerRefreshUsageLimitsResult.Type;

export const WsServerRefreshUsageLimitsRpc = Rpc.make(WS_METHODS.serverRefreshUsageLimits, {
  payload: Schema.Struct({}),
  success: ServerRefreshUsageLimitsResult,
});
