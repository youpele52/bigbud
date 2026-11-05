import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { WS_METHODS } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { sampleSshMonitorEffect, listConnectedSshMonitorsEffect } from "./wsSshMonitor.ts";
import { sshMonitorCallerId } from "../ssh/sshMonitor.connections.ts";

export interface SshMonitorRpcOptions {
  readonly clientId: number;
}

export function makeSshMonitorHandlers(context: WsRpcContext) {
  const projects = context.projectionProjectRepository;
  const caller = (options?: SshMonitorRpcOptions) =>
    sshMonitorCallerId(context.monitorInstanceId, options?.clientId);
  return {
    [WS_METHODS.serverSampleSshMonitor]: (
      input: { projectId: ProjectId },
      options?: SshMonitorRpcOptions,
    ) => {
      const callerId = caller(options);
      return observeRpcEffect(
        WS_METHODS.serverSampleSshMonitor,
        Option.isSome(projects) && callerId
          ? sampleSshMonitorEffect(input, projects.value, callerId)
          : Effect.fail("SSH monitor caller or persistence unavailable"),
        { "rpc.aggregate": "server" },
      );
    },
    [WS_METHODS.serverListConnectedSshMonitors]: (_input: {}, options?: SshMonitorRpcOptions) => {
      const callerId = caller(options);
      return observeRpcEffect(
        WS_METHODS.serverListConnectedSshMonitors,
        Option.isSome(projects) && callerId
          ? listConnectedSshMonitorsEffect(projects.value, callerId)
          : Effect.fail("SSH monitor caller or persistence unavailable"),
        { "rpc.aggregate": "server" },
      );
    },
  };
}
