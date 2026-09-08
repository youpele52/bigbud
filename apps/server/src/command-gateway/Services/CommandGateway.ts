import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export const CommandGatewaySources = [
  "desktop",
  "mobile",
  "automation",
  "provider",
  "startup",
  "internal",
] as const;
export type CommandGatewaySource = (typeof CommandGatewaySources)[number];

export interface CommandGatewayRequestContext {
  readonly actor: string;
  readonly source: CommandGatewaySource;
  readonly authorizationScope: "authenticated-session" | "internal";
}

export interface CommandGatewayShape {
  readonly dispatchNormalized: (input: {
    readonly command: OrchestrationCommand;
    readonly context: CommandGatewayRequestContext;
  }) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}

export class CommandGateway extends ServiceMap.Service<CommandGateway, CommandGatewayShape>()(
  "bigbud/command-gateway/Services/CommandGateway",
) {}
