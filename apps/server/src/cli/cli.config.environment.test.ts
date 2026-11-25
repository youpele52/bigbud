import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { EnvServerConfig } from "./cli.config.environment";

it.effect("ignores legacy environment configuration", () =>
  Effect.gen(function* () {
    const config = yield* EnvServerConfig.asEffect().pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { T3CODE_PORT: "4001", T3CODE_LOG_LEVEL: "Warn" } }),
        ),
      ),
    );
    expect(config.port).toBeUndefined();
    expect(config.logLevel).toBe("Info");
  }),
);
