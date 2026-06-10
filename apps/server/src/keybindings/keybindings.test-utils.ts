import { KeybindingRule, KeybindingsConfig, KeybindingsConfigError } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ServerConfig } from "../startup/config";
import { KeybindingsLive } from "./keybindings";

export const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);

export const makeKeybindingsLayer = () => {
  return KeybindingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "bigbud-keybindings-test-",
        }),
      ),
    ),
  );
};

export const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* Schema.encodeEffect(KeybindingsConfigJson)(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

export const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* Schema.decodeUnknownEffect(KeybindingsConfigJson)(rawConfig);
  });

export const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );
