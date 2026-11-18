import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { afterEach, expect, it } from "vitest";
import {
  RemoteCallbackBinding,
  RemoteCallbackBindingLive,
  withRemoteCallbackRuntime,
} from "./server.remote.callbackBinding.ts";
import { callbackFixture } from "./server.remote.callbackBinding.fixture.ts";
import { ServerConfig } from "./startup/config.ts";
import { AUTHORITY_FILENAME } from "./remote-backend/authority.files.ts";

const fixtures: Awaited<ReturnType<typeof callbackFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture(port = 0) {
  const value = await callbackFixture(port);
  fixtures.push(value);
  return value;
}
const listen = (port: number) =>
  new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const binding = (f: Awaited<ReturnType<typeof fixture>>) =>
  RemoteCallbackBindingLive.pipe(Layer.provideMerge(f.identityLayer));

it("keeps concurrent automatic callback listeners reserved until their original scopes close", async () => {
  const a = await fixture();
  const b = await fixture();
  const ports = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const [left, right] = yield* Effect.all(
          [Layer.build(binding(a)), Layer.build(binding(b))],
          { concurrency: "unbounded" },
        );
        const ports = [left, right].map(
          (context) => ServiceMap.get(context, RemoteCallbackBinding).config.port,
        );
        expect(ports[0]).toBeGreaterThan(0);
        expect(ports[1]).toBeGreaterThan(0);
        expect(ports[0]).not.toBe(ports[1]);
        yield* Effect.promise(async () => {
          for (const port of ports)
            await expect(listen(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
        });
        return ports;
      }),
    ),
  );
  for (const port of ports) await close(await listen(port));
  // The auto-port owner record is an unknown-port sentinel, never rewritten around active proofs.
  expect(JSON.parse(await fs.readFile(a.owner.lockPath, "utf8")).port).toBe(0);
});

it("one runtime captures the actual port and serves through that exact original HttpServer", async () => {
  const f = await fixture();
  let runtimeBuilds = 0;
  let applicationBuilds = 0;
  const runtime = Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const bound = yield* RemoteCallbackBinding;
      expect(config).toBe(bound.config);
      expect(config).not.toBe(f.config);
      expect(config.port).toBeGreaterThan(0);
      expect(config.terminalShellInstallEvidence).toBe(f.config.terminalShellInstallEvidence);
      runtimeBuilds++;
    }),
  );
  const application = Layer.unwrap(
    Effect.gen(function* () {
      const bound = yield* RemoteCallbackBinding;
      applicationBuilds++;
      return HttpServer.serve(Effect.succeed(HttpServerResponse.text("callback-only"))).pipe(
        Layer.provide(Layer.succeedServices(bound.httpServices)),
      );
    }),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          withRemoteCallbackRuntime(application, runtime).pipe(Layer.provideMerge(binding(f))),
        );
        const bound = ServiceMap.get(context, RemoteCallbackBinding);
        const response = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${bound.config.port}`),
        );
        expect(yield* Effect.promise(() => response.text())).toBe("callback-only");
        expect(runtimeBuilds).toBe(1);
        expect(applicationBuilds).toBe(1);
        expect(f.config.port).toBe(0);
      }),
    ),
  );
});

it("an explicit occupied port fails before any runtime services build", async () => {
  const occupied = await listen(0);
  try {
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
    const f = await fixture(address.port);
    let builds = 0;
    const runtime = Layer.effectDiscard(
      Effect.sync(() => {
        builds++;
      }),
    );
    const error = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          withRemoteCallbackRuntime(Layer.empty, runtime).pipe(Layer.provideMerge(binding(f))),
        ),
      ).pipe(Effect.flip),
    );
    expect(error).toMatchObject({ _tag: "ServeError", cause: { code: "EADDRINUSE" } });
    expect(builds).toBe(0);
    expect(occupied.listening).toBe(true);
  } finally {
    await close(occupied);
  }
});

it("original pinned identity refusal precedes binding or runtime construction", async () => {
  const occupied = await listen(0);
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  try {
    const f = await fixture(address.port);
    await fs.unlink(`${f.config.stateDir}/${AUTHORITY_FILENAME}`);
    await expect(Effect.runPromise(Effect.scoped(Layer.build(binding(f))))).rejects.toThrow(
      "no replacement identity was generated",
    );
    expect(occupied.listening).toBe(true);
  } finally {
    await close(occupied);
  }
});

it("runtime construction failure releases the already-reserved listener", async () => {
  const f = await fixture();
  let port = 0;
  const runtime = Layer.effectDiscard(
    Effect.gen(function* () {
      port = (yield* ServerConfig).port;
      return yield* Effect.fail("fixture-runtime-failure");
    }),
  );
  await expect(
    Effect.runPromise(
      Effect.scoped(
        Layer.build(
          withRemoteCallbackRuntime(Layer.empty, runtime).pipe(Layer.provideMerge(binding(f))),
        ),
      ),
    ),
  ).rejects.toThrow("fixture-runtime-failure");
  expect(port).toBeGreaterThan(0);
  await close(await listen(port));
  await f.owner.assertHeld();
});
