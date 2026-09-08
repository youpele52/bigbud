import { Effect, Layer } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { toDispatchCommandError } from "../../ws/wsDispatchCommandError.ts";
import { CommandGateway, type CommandGatewayShape } from "../Services/CommandGateway.ts";
import { authorizeCommandGatewayContext } from "../CommandGateway.auth.ts";

const makeCommandGateway = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;

  const dispatchNormalized: CommandGatewayShape["dispatchNormalized"] = (input) =>
    Effect.gen(function* () {
      const authorizationError = authorizeCommandGatewayContext(input.context);
      if (authorizationError) return yield* authorizationError;
      return yield* orchestrationEngine.dispatch(input.command);
    }).pipe(
      Effect.annotateLogs({
        "command_gateway.actor": input.context.actor,
        "command_gateway.source": input.context.source,
        "command_gateway.authorization_scope": input.context.authorizationScope,
        "orchestration.command_id": input.command.commandId,
        "orchestration.command_type": input.command.type,
      }),
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
      ),
    );

  return { dispatchNormalized } satisfies CommandGatewayShape;
});

export const CommandGatewayLive = Layer.effect(CommandGateway, makeCommandGateway);
