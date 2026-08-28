import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

import {
  CommandGatewaySources,
  type CommandGatewayRequestContext,
  type CommandGatewaySource,
} from "./Services/CommandGateway.ts";

const allowedSources = new Set<string>(CommandGatewaySources);
const internalSources = new Set<CommandGatewaySource>(["internal", "provider", "startup"]);

function reject(message: string) {
  return new OrchestrationDispatchCommandError({
    message,
    code: "unauthorized",
  });
}

export function authorizeCommandGatewayContext(
  context: CommandGatewayRequestContext,
): OrchestrationDispatchCommandError | null {
  if (!context.actor.trim()) return reject("Command gateway actor is required.");
  if (!allowedSources.has(context.source)) return reject("Command gateway source is not allowed.");

  const isInternalSource = internalSources.has(context.source);
  if (isInternalSource && context.authorizationScope !== "internal") {
    return reject("Internal command gateway source requires internal authorization.");
  }
  if (!isInternalSource && context.authorizationScope !== "authenticated-session") {
    return reject("Public command gateway source requires authenticated-session authorization.");
  }
  return null;
}
