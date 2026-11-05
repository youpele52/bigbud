import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  OrchestrationGetOrganizationThreadSummariesError,
  type GetOrganizationThreadSummariesInput,
} from "@bigbud/contracts/orchestration/orchestration.catalog.organization.ts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

/** Read-only Inyosira catalog pages. Moves go through the normal command dispatch. */
export function makeOrganizationWsRpcHandlers(context: WsRpcContext) {
  return {
    [ORCHESTRATION_WS_METHODS.getOrganizationThreadSummaries]: (
      input: GetOrganizationThreadSummariesInput,
    ) =>
      observeRpcEffect(
        ORCHESTRATION_WS_METHODS.getOrganizationThreadSummaries,
        context.projectionCatalogQuery.getOrganizationThreadSummaries(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetOrganizationThreadSummariesError({
                message: "Failed to load Inyosira thread summaries",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestration" },
      ),
  };
}
