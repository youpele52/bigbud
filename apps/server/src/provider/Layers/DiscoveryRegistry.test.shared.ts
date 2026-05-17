import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";

import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import { DiscoveryRegistry } from "../Services/DiscoveryRegistry";
import { DiscoveryRegistryLive } from "./DiscoveryRegistry";

const makeStubSettingsLayer = () =>
  Layer.succeed(ServerSettingsService, {
    start: Effect.void,
    ready: Effect.void,
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
    streamChanges: Stream.empty,
  });

const makeRegistryLayer = (cwd: string) =>
  DiscoveryRegistryLive.pipe(
    Layer.provideMerge(makeStubSettingsLayer()),
    Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "discovery-registry-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

export const getCatalog = (cwd: string) =>
  Effect.gen(function* () {
    const registry = yield* DiscoveryRegistry;
    return yield* registry.getCatalog;
  }).pipe(Effect.provide(makeRegistryLayer(cwd)));

export const writeFile = (filePath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, content);
  });
