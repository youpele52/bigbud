import { NetService } from "@bigbud/shared/Net";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { resolveServerConfig, type CliServerFlags } from "./cli.config.ts";

export const flagsFor = (baseDir: string, cwd: string): CliServerFlags => ({
  mode: Option.some("remote"),
  port: Option.some(4888),
  host: Option.none(),
  baseDir: Option.some(baseDir),
  cwd: Option.some(cwd),
  devUrl: Option.none(),
  noBrowser: Option.some(false),
  authToken: Option.some("fixture-owner-secret"),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.some(true),
  logWebSocketEvents: Option.none(),
});

export const resolve = (
  flags: CliServerFlags,
  onPortProbe: () => void = () => {},
  env: Record<string, string> = {},
) =>
  resolveServerConfig(flags, Option.none(), "linux").pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        Layer.mock(NetService)({
          findAvailablePort: () =>
            Effect.sync(() => {
              onPortProbe();
              return 4888;
            }),
        }),
      ),
    ),
  );
