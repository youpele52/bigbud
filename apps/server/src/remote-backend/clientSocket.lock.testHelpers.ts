import http from "node:http";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { expect } from "vitest";
import { remoteUnixHttpServerLive } from "../server.platform.ts";
import { serveIsolatedRemoteRoutes } from "../server.remote.listener.ts";
import { BootstrapCommandLockLive, BootstrapCommandLockService } from "../ws/wsBootstrap.lock.ts";

/** Exercise real simultaneous HTTP arrivals across separate router/listener subtrees. */
export async function assertSharedRemoteBootstrapLock(root: string) {
  const events: string[] = [];
  let enterFirst!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterFirst = resolve;
  });
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let attemptSecond!: () => void;
  const attempted = new Promise<void>((resolve) => {
    attemptSecond = resolve;
  });
  const routes = (label: "client" | "mobile") =>
    HttpRouter.add(
      "POST",
      "/bootstrap",
      Effect.gen(function* () {
        const lock = yield* BootstrapCommandLockService;
        if (label === "mobile") attemptSecond();
        return yield* lock(
          "same-parent-command",
          Effect.gen(function* () {
            events.push(`${label}-start`);
            if (label === "client") {
              enterFirst();
              yield* Effect.promise(() => gate);
            }
            events.push(`${label}-end`);
            return HttpServerResponse.empty({ status: 204 });
          }),
        );
      }),
    );
  const listener = (label: "client" | "mobile") =>
    serveIsolatedRemoteRoutes(routes(label)).pipe(
      Layer.provide(remoteUnixHttpServerLive(join(root, `${label}-lock.sock`))),
    );
  const application = Layer.mergeAll(listener("client"), listener("mobile")).pipe(
    Layer.provide(BootstrapCommandLockLive),
  );
  const request = (label: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        { socketPath: join(root, `${label}-lock.sock`), method: "POST", path: "/bootstrap" },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode!));
        },
      );
      req.setTimeout(3000, () => req.destroy(new Error("Lock HTTP request deadline")));
      req.once("error", reject);
      req.end();
    });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(application);
        yield* Effect.promise(async () => {
          const first = request("client");
          try {
            await Promise.race([
              entered,
              first.then(() => {
                throw new Error("Client request ended before entering lock");
              }),
            ]);
            const second = request("mobile");
            try {
              await Promise.race([
                attempted,
                second.then(() => {
                  throw new Error("Mobile request ended before attempting lock");
                }),
              ]);
              expect(events).toEqual(["client-start"]);
            } finally {
              releaseFirst();
            }
            expect(await second).toBe(204);
            expect(await first).toBe(204);
            expect(events).toEqual(["client-start", "client-end", "mobile-start", "mobile-end"]);
          } finally {
            releaseFirst();
            await first;
          }
        });
      }),
    ),
  );
}
