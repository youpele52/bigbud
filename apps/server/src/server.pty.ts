import { Effect, Layer } from "effect";
import { ServerConfig } from "./startup/config.ts";
import { PtyAdapter } from "./terminal/Services/PTY.ts";
import { terminalPtyBackend } from "./terminal/Layers/PTY.backend.ts";
import { RemoteLocalSupervisorPtyLive } from "./remote-backend/localSupervisorLayer.ts";
import {
  localTerminalHostSelection,
  makeLocalTerminalHostPtyLive,
} from "./terminal-host/localTerminalHost.layer.ts";

type InProcessPtyLayer =
  | typeof import("./terminal/Layers/NodePTY").layer
  | typeof import("./terminal/Layers/BunPTY").layer;
type LocalTerminalHostPtyLayer = ReturnType<
  typeof makeLocalTerminalHostPtyLive<
    Layer.Error<InProcessPtyLayer>,
    Layer.Services<InProcessPtyLayer>
  >
>;
type ConfiguredPtyLayer = Layer.Layer<
  PtyAdapter,
  | Layer.Error<typeof RemoteLocalSupervisorPtyLive>
  | Layer.Error<InProcessPtyLayer>
  | Layer.Error<LocalTerminalHostPtyLayer>,
  | Layer.Services<typeof RemoteLocalSupervisorPtyLive>
  | Layer.Services<InProcessPtyLayer>
  | Layer.Services<LocalTerminalHostPtyLayer>
>;
export const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.mode === "remote") {
      const selected: ConfiguredPtyLayer = RemoteLocalSupervisorPtyLive;
      return selected;
    }
    let inProcess: InProcessPtyLayer;
    if (terminalPtyBackend(process.platform, typeof Bun !== "undefined") === "bun") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY"));
      inProcess = BunPTY.layer;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY"));
      inProcess = NodePTY.layer;
    }
    // Unset flag and no existing host root: exactly the in-process adapter, unchanged.
    const hostMode = localTerminalHostSelection({ stateDir: config.stateDir });
    const selected: ConfiguredPtyLayer = hostMode
      ? makeLocalTerminalHostPtyLive(hostMode, inProcess)
      : inProcess;
    return selected;
  }),
);
