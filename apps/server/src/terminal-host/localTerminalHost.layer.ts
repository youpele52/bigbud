import { existsSync } from "node:fs";
import { Effect, Layer } from "effect";

import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { RemoteAgentRuntimeOwnersLive } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { ServerConfig } from "../startup/config.ts";
import { PtyAdapter, type PtyAdapterShape } from "../terminal/Services/PTY.ts";
import { makeLocalTerminalHostPtyAdapter } from "./localTerminalHost.adapter.ts";
import {
  collectLocalTerminalHostRuntimes,
  resolveLocalTerminalHostSource,
  stageLocalTerminalHostBinary,
  verifyStagedLocalTerminalHostBinary,
} from "./localTerminalHost.binary.ts";
import { makeLocalTerminalHostController } from "./localTerminalHost.host.ts";
import {
  launchLocalTerminalHost,
  prepareLocalTerminalHostGeneration,
} from "./localTerminalHost.launch.ts";
import { localTerminalHostGenerationHasOwners } from "./localTerminalHost.owners.ts";
import {
  LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
  localTerminalHostPaths,
  resolveLocalTerminalHostMode,
  type LocalTerminalHostMode,
} from "./localTerminalHost.paths.ts";
import { probeLocalTerminalHost } from "./localTerminalHost.probe.ts";
import { makeLocalTerminalHostProcesses } from "./localTerminalHost.process.ts";
import { makeLocalTerminalHostRegistry } from "./localTerminalHost.registry.ts";

/**
 * Whether the local terminal host participates at all. Enabled mode always does. Adopt-only (the
 * kill switch, and the default before Q1) participates only when a host root already exists, so
 * a user who never set the flag gets exactly the in-process behavior. Windows stays in-process
 * until M10.
 */
export function localTerminalHostSelection(input: {
  readonly stateDir: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly rootExists?: (root: string) => boolean;
}): LocalTerminalHostMode | undefined {
  if ((input.platform ?? process.platform) === "win32") return undefined;
  const mode = resolveLocalTerminalHostMode(input.environment ?? process.env);
  if (mode === "enabled") return mode;
  const { root } = localTerminalHostPaths(input.stateDir);
  return (input.rootExists ?? existsSync)(root) ? mode : undefined;
}

/**
 * `LocalTerminalHostPtyLive` wraps the in-process adapter (`PtyAdapter` from `fallback`).
 * Construction never launches a host; adoption runs in the background and a host starts only
 * when the first new local terminal needs one.
 */
export const makeLocalTerminalHostPtyLive = <E, R>(
  mode: LocalTerminalHostMode,
  fallback: Layer.Layer<PtyAdapter, E, R>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const inProcess = yield* PtyAdapter;
      const owners = yield* RemoteAgentRuntimeOwners;
      const services = yield* Effect.services<never>();
      const log = (message: string, detail?: Record<string, unknown>) =>
        Effect.runForkWith(services)(
          Effect.logWarning(message, detail ?? {}).pipe(
            Effect.annotateLogs({ component: "local-terminal-host" }),
          ),
        );
      const paths = localTerminalHostPaths(config.stateDir);
      const processes = makeLocalTerminalHostProcesses();
      const controller = makeLocalTerminalHostController({
        mode,
        paths,
        registry: makeLocalTerminalHostRegistry(paths, (cause) =>
          log("hosts.json is unreadable; host PIDs are treated as unverifiable.", {
            cause: String(cause),
          }),
        ),
        processes,
        requiredCapabilities: LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
        generationHasOwners: (connectionId, epoch) =>
          localTerminalHostGenerationHasOwners(owners, connectionId, epoch),
        log,
        stage: async () => stageLocalTerminalHostBinary(paths, resolveLocalTerminalHostSource()),
        verifyStaged: (staged) => verifyStagedLocalTerminalHostBinary(paths, staged),
        collectRuntimes: (keep) => collectLocalTerminalHostRuntimes(paths, keep),
        probe: (generation, proxyBinary) => probeLocalTerminalHost({ generation, proxyBinary }),
        prepareGeneration: (generation) =>
          prepareLocalTerminalHostGeneration(paths.root, generation),
        launch: (input) => launchLocalTerminalHost(input),
      });
      const local = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeLocalTerminalHostPtyAdapter({
            controller,
            owners,
            fallback: inProcess,
            stateDir: config.stateDir,
            log,
          }),
        ),
        (local) => Effect.sync(local.close),
      );
      void controller.ready().catch((cause: unknown) => {
        log("Local terminal host adoption did not complete; new terminals run in-process.", {
          cause: String(cause),
        });
      });
      return Layer.succeed(PtyAdapter, local.adapter satisfies PtyAdapterShape);
    }),
  ).pipe(Layer.provide(fallback), Layer.provide(RemoteAgentRuntimeOwnersLive));
