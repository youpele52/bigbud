import { Effect, Layer } from "effect";

import { ConnectionDiagnostics } from "../Services/ConnectionDiagnostics.ts";

/**
 * Flips the server-shutting-down signal from its finalizer. Layers release in
 * reverse build order, and the HTTP routes are released before the runtime
 * services they depend on, so WebSocket delivery streams close before the
 * delivery coordinator marks its sessions as shut down. This layer must
 * therefore be built after the routes; use `withServerShutdownSignal`.
 */
export const ServerShutdownSignalLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const diagnostics = yield* ConnectionDiagnostics;
    yield* Effect.addFinalizer(() => diagnostics.markServerShuttingDown);
  }),
);

/**
 * Wraps the server application so the shutdown signal depends on it, is built
 * after it, and is therefore the first finalizer to run when the server scope
 * closes, whether by interrupt or by a normal exit.
 */
export const withServerShutdownSignal = <ROut, E, RIn>(application: Layer.Layer<ROut, E, RIn>) =>
  ServerShutdownSignalLive.pipe(Layer.provideMerge(application));
