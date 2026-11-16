import { Effect, Layer } from "effect";
import { ServerConfig } from "./startup/config.ts";
import { PtyAdapter } from "./terminal/Services/PTY.ts";
import { terminalPtyBackend } from "./terminal/Layers/PTY.backend.ts";
import { RemoteLocalSupervisorPtyLive } from "./remote-backend/localSupervisorLayer.ts";

type ConfiguredPtyLayer = Layer.Layer<
  PtyAdapter,
  | Layer.Error<typeof RemoteLocalSupervisorPtyLive>
  | Layer.Error<typeof import("./terminal/Layers/NodePTY").layer>
  | Layer.Error<typeof import("./terminal/Layers/BunPTY").layer>,
  | Layer.Services<typeof RemoteLocalSupervisorPtyLive>
  | Layer.Services<typeof import("./terminal/Layers/NodePTY").layer>
  | Layer.Services<typeof import("./terminal/Layers/BunPTY").layer>
>;
export const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.mode === "remote") {
      const selected: ConfiguredPtyLayer = RemoteLocalSupervisorPtyLive;
      return selected;
    }
    if (terminalPtyBackend(process.platform, typeof Bun !== "undefined") === "bun") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY"));
      const selected: ConfiguredPtyLayer = BunPTY.layer;
      return selected;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY"));
      const selected: ConfiguredPtyLayer = NodePTY.layer;
      return selected;
    }
  }),
);
