import { Effect } from "effect";
import type { ServerVerifyExecutionTargetInput } from "@bigbud/contracts/server/server.ts";
import {
  recordVerifiedSshMonitorTarget,
  sshMonitorCallerId,
} from "../ssh/sshMonitor.connections.ts";
import { verifyExecutionTargetEffect } from "./wsExecutionTargetVerification.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

/** Verification may serve other SSH features, but only RPC metadata admits monitor sampling. */
export function verifyAndAdmitSshMonitorTarget(
  input: ServerVerifyExecutionTargetInput,
  context: WsRpcContext,
  clientId?: number,
) {
  return verifyExecutionTargetEffect(
    input,
    context.remoteAgentHealth,
    context.remoteAgentUpdateCoordinator,
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        recordVerifiedSshMonitorTarget(
          input.executionTargetId,
          sshMonitorCallerId(context.monitorInstanceId, clientId),
        ),
      ),
    ),
  );
}
