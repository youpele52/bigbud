import { CommandId, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { CommandGateway } from "../Services/CommandGateway.ts";
import { CommandGatewayLive } from "./CommandGateway.ts";

const command = {
  type: "project.create" as const,
  commandId: CommandId.makeUnsafe("cmd-gateway"),
  projectId: ProjectId.makeUnsafe("project-gateway"),
  title: "Gateway",
  workspaceRoot: null,
  defaultModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
  createdAt: "2026-08-27T00:00:00.000Z",
};

function runWithGateway<A>(
  program: Effect.Effect<A, OrchestrationDispatchCommandError, CommandGateway>,
) {
  let dispatchCount = 0;
  const layer = CommandGatewayLive.pipe(
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: () =>
          Effect.sync(() => {
            dispatchCount += 1;
            return { sequence: 9 };
          }),
        getReadModel: () => Effect.die("unused"),
        readEvents: () => Stream.empty,
        readReplay: () => Effect.die("unused"),
        streamDomainEvents: Stream.empty,
      } as never),
    ),
  );
  return {
    dispatchCount: () => dispatchCount,
    effect: program.pipe(Effect.provide(layer)),
  };
}

describe("CommandGatewayLive", () => {
  it.effect("dispatches normalized commands through the TypeScript gateway facade", () => {
    const run = runWithGateway(
      Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        return yield* gateway.dispatchNormalized({
          command,
          context: {
            actor: "authenticated-user",
            source: "desktop",
            authorizationScope: "authenticated-session",
          },
        });
      }),
    );
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* run.effect, { sequence: 9 });
      assert.strictEqual(run.dispatchCount(), 1);
    });
  });

  it.effect("rejects unauthorized public/internal context mismatches before dispatch", () => {
    const run = runWithGateway(
      Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        return yield* Effect.exit(
          gateway.dispatchNormalized({
            command,
            context: {
              actor: "authenticated-user",
              source: "desktop",
              authorizationScope: "internal",
            },
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const exit = yield* run.effect;
      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(run.dispatchCount(), 0);
    });
  });

  it.effect("rejects internal claims without internal authorization before dispatch", () => {
    const run = runWithGateway(
      Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        return yield* Effect.exit(
          gateway.dispatchNormalized({
            command,
            context: {
              actor: "authenticated-user",
              source: "internal",
              authorizationScope: "authenticated-session",
            },
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const exit = yield* run.effect;
      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(run.dispatchCount(), 0);
    });
  });

  it.effect("accepts mobile automation and internal contexts", () =>
    Effect.gen(function* () {
      for (const [source, authorizationScope, actor] of [
        ["mobile", "authenticated-session", "authenticated-user"],
        ["automation", "authenticated-session", "authenticated-user"],
        ["internal", "internal", "server"],
      ] as const) {
        const run = runWithGateway(
          Effect.gen(function* () {
            const gateway = yield* CommandGateway;
            return yield* gateway.dispatchNormalized({
              command,
              context: { actor, source, authorizationScope },
            });
          }),
        );
        assert.deepStrictEqual(yield* run.effect, { sequence: 9 });
        assert.strictEqual(run.dispatchCount(), 1);
      }
    }),
  );

  it.effect("rejects unknown source values before dispatch", () => {
    const run = runWithGateway(
      Effect.gen(function* () {
        const gateway = yield* CommandGateway;
        return yield* Effect.exit(
          gateway.dispatchNormalized({
            command,
            context: {
              actor: "authenticated-user",
              source: "unknown",
              authorizationScope: "authenticated-session",
            } as never,
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const exit = yield* run.effect;
      assert.strictEqual(exit._tag, "Failure");
      assert.strictEqual(run.dispatchCount(), 0);
    });
  });
});
