import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

/** HttpRouter.layer is a singleton. Isolate its memoization without rebuilding runtime services. */
export function serveIsolatedRemoteRoutes<A, E, R>(routes: Layer.Layer<A, E, R>) {
  return Layer.fresh(HttpRouter.serve(routes, { disableLogger: true }));
}
