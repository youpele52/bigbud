import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { isDevPortAvailable } from "@bigbud/shared/DevPortAvailability";
import {
  createDevPortCoordinator,
  readDevPortReservations,
  reserveDevPort,
} from "@bigbud/shared/DevPortCoordinator";
import { devPortsForOffset } from "@bigbud/shared/DevPorts";
import * as Effect from "effect/Effect";

import { DevRunnerError, resolveModePortOffsets, type DevMode } from "./dev-runner.lib.ts";

export interface CoordinatedRunnerPortsInput {
  mode: DevMode;
  startOffset: number;
  hasExplicitServerPort: boolean;
  hasExplicitDevUrl: boolean;
  dryRun: boolean;
  repoRoot?: string;
  storageRoot?: string;
}

export const reserveRunnerPorts = Effect.fn("reserveRunnerPorts")(function* (
  input: CoordinatedRunnerPortsInput,
) {
  const runSelection = Effect.runPromiseWith(yield* Effect.services());
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  let lease: Awaited<ReturnType<typeof reserveDevPort>> | undefined;
  // Install cleanup before starting any asynchronous acquisition. Later child
  // finalizers run first (LIFO), keeping the parent's lease through child teardown.
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      controller.abort();
      // tryPromise interruption does not await its JavaScript Promise. Join it
      // before releasing a lease that may still be in the middle of publication.
      await pending;
      await lease?.release();
    }),
  );
  const allocation = yield* Effect.tryPromise({
    try: (interruptionSignal) => {
      const signal = AbortSignal.any([interruptionSignal, controller.signal]);
      const acquisition = (async () => {
        const repoRoot = await realpath(
          input.repoRoot ?? fileURLToPath(new URL("..", import.meta.url)),
        );
        signal.throwIfAborted();
        const launchesWeb = ["dev", "dev:desktop", "dev:web"].includes(input.mode);
        const select = (reserved: ReadonlySet<number>) =>
          runSelection(
            resolveModePortOffsets<never>({
              ...input,
              // --dev-url changes the advertised origin, not the local Vite
              // port. Every locally launched web listener needs a reservation.
              hasExplicitDevUrl: launchesWeb ? false : input.hasExplicitDevUrl,
              checkPortAvailability: (port) =>
                Effect.promise(async () => {
                  signal.throwIfAborted();
                  return !reserved.has(port) && (await isDevPortAvailable(port));
                }),
            }),
          );
        if (input.dryRun || !launchesWeb) {
          return { ...(await select(new Set())), repoRoot, lease: undefined };
        }
        const coordinator = await createDevPortCoordinator(repoRoot, input.storageRoot);
        return coordinator.withLock(async () => {
          const reserved = new Set((await readDevPortReservations(coordinator)).map((r) => r.port));
          const offsets = await select(reserved);
          signal.throwIfAborted();
          lease = await reserveDevPort(
            coordinator,
            devPortsForOffset(offsets.webOffset).webPort,
            "web",
          );
          signal.throwIfAborted();
          return { ...offsets, repoRoot, lease };
        }, signal);
      })();
      // The acquisition reports failure through tryPromise; cleanup still needs
      // a settling handshake on failure, interruption, and successful allocation.
      pending = acquisition.then(
        () => undefined,
        () => undefined,
      );
      return acquisition;
    },
    catch: (cause) => new DevRunnerError({ message: "Could not reserve development ports", cause }),
  });
  return {
    serverOffset: allocation.serverOffset,
    webOffset: allocation.webOffset,
    repoRoot: allocation.repoRoot,
    webReservation: allocation.lease?.reservation.token,
  };
});
