import * as Rpc from "effect/unstable/rpc/Rpc";

import { ORCHESTRATION_WS_METHODS } from "../constants/websocket.constant";
import {
  GetOrganizationThreadSummariesInput,
  GetOrganizationThreadSummariesResult,
  OrchestrationGetOrganizationThreadSummariesError,
} from "../orchestration/orchestration.catalog.organization";

export const WsOrchestrationGetOrganizationThreadSummariesRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getOrganizationThreadSummaries,
  {
    payload: GetOrganizationThreadSummariesInput,
    success: GetOrganizationThreadSummariesResult,
    error: OrchestrationGetOrganizationThreadSummariesError,
  },
);
