import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { makeProjectWorkspaceNativeCoordinator } from "../../orchestration/ProjectWorkspace.nativeCoordinator.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { toDispatchCommandError } from "../../ws/wsDispatchCommandError.ts";
import { CommandGateway, type CommandGatewayShape } from "../Services/CommandGateway.ts";
import { authorizeCommandGatewayContext } from "../CommandGateway.auth.ts";

const makeCommandGateway = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const registry = yield* Effect.serviceOption(ProviderAdapterRegistry);
  const receipts = yield* Effect.serviceOption(OrchestrationCommandReceiptRepository);
  // No V2 capability is installed until native relocation qualification is satisfied.
  const dispatch =
    Option.isSome(sql) && Option.isSome(registry)
      ? makeProjectWorkspaceNativeCoordinator({
          sql: sql.value,
          registry: registry.value,
          engine: orchestrationEngine,
          ...(Option.isSome(receipts) ? { receipts: receipts.value } : {}),
        })
      : orchestrationEngine.dispatch;

  const dispatchNormalized: CommandGatewayShape["dispatchNormalized"] = (input) =>
    Effect.gen(function* () {
      const authorizationError = authorizeCommandGatewayContext(input.context);
      if (authorizationError) return yield* authorizationError;
      return yield* dispatch(input.command);
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
