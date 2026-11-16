import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@bigbud/shared/Net";
import { version } from "../package.json" with { type: "json" };
import { registerServerLifecycleDiagnostics } from "./serverLifecycleDiagnostics.ts";
import { ServerConfig } from "./startup/config.ts";

// Keep platform services behind the initialized entry. Static NodeServices imports can
// form an emitted chunk cycle back to Effect bindings owned by this entry.
const CliRuntimeLayer = Layer.unwrap(
  Effect.promise(async () => {
    const NodeServices = await import("@effect/platform-node/NodeServices");
    return Layer.mergeAll(NodeServices.layer, NetService.layer);
  }),
);

registerServerLifecycleDiagnostics();

// Consume the internal marker before CLI/provider imports or child processes can inherit it.
const serviceConfigPath = process.env.BIGBUD_REMOTE_SERVICE_CONFIG;
const servicePreflightOnly = process.env.BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY;
delete process.env.BIGBUD_REMOTE_SERVICE_CONFIG;
delete process.env.BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY;

Effect.gen(function* () {
  if (process.argv[2] === "--remote-service-capabilities") {
    if (
      process.argv.length !== 3 ||
      serviceConfigPath !== undefined ||
      servicePreflightOnly !== undefined
    )
      return yield* Effect.fail(new Error("Invalid account-service capability invocation."));
    yield* Effect.sync(() => {
      process.stdout.write(
        JSON.stringify({ schemaVersion: 1, backendVersion: version, accountServicePreflight: 1 }) +
          "\n",
      );
    });
    return;
  }
  if (serviceConfigPath !== undefined || servicePreflightOnly !== undefined) {
    const config = yield* Effect.gen(function* () {
      if (
        serviceConfigPath === undefined ||
        (servicePreflightOnly !== undefined && servicePreflightOnly !== "1")
      )
        return yield* Effect.fail(new Error("Invalid account-service preflight invocation."));
      const { preflightLocalSupervisorService } = yield* Effect.promise(
        () => import("./remote-backend/localSupervisorService.startup.ts"),
      );
      return yield* preflightLocalSupervisorService(serviceConfigPath);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          // The resolved config owns these values. Provider subprocesses must not inherit them.
          for (const key of [
            "BIGBUD_AUTH_TOKEN",
            "T3CODE_AUTH_TOKEN",
            "BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL",
          ])
            delete process.env[key];
        }),
      ),
    );
    // Explicit enablement uses this same canonical finite bridge before changing boot policy.
    if (servicePreflightOnly === "1") return;
    const { runServer } = yield* Effect.promise(() => import("./server.ts"));
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  }
  const { cli } = yield* Effect.promise(() => import("./cli/cli"));
  return yield* Command.run(cli, { version });
}).pipe(Effect.scoped, Effect.provide(CliRuntimeLayer), NodeRuntime.runMain);
