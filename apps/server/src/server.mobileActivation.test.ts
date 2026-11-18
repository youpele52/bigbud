import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, expect, it, vi } from "vitest";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { RemoteAgentRuntimeOwnersLive } from "./persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { RemoteAgentRuntimeOwners } from "./persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { RemoteAgentOwnerStore } from "./remote-agent/remoteAgentOwners.ts";
import { RemoteMobileNativeInputs } from "./remote-backend/mobileGatewayActivation.inputs.ts";
import {
  RemoteMobileGatewayActivation,
  RemoteMobileGatewayActivationLive,
} from "./remote-backend/mobileGatewayActivation.service.ts";
import {
  RemoteMobileActivationAttachLive,
  RemoteMobileActivationLive,
} from "./server.mobileActivation.ts";

const seen = vi.hoisted(() => ({
  factories: 0,
  closes: 0,
  owners: [] as unknown[],
}));
// The real controller over the real launch; the seam only records its construction context.
vi.mock("./remote-backend/mobileGatewayActivation.controller.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./remote-backend/mobileGatewayActivation.controller.ts")>();
  const { Effect } = await import("effect");
  const { RemoteAgentRuntimeOwners } =
    await import("./persistence/Layers/RemoteAgentRuntimeBindings.service.ts");
  return {
    ...actual,
    makeNativeMobileActivationController: (inputs: never) =>
      Effect.gen(function* () {
        seen.factories++;
        seen.owners.push(yield* RemoteAgentRuntimeOwners);
        const controller = yield* actual.makeNativeMobileActivationController(inputs);
        return {
          ...controller,
          close: () => (seen.closes++, controller.close()),
        };
      }),
  };
});
afterEach(() => {
  seen.factories = 0;
  seen.closes = 0;
  seen.owners.length = 0;
});

const request = {
  requestId: "00000000-0000-4000-8000-000000000001",
  configuration: { externalOrigin: "https://fixture.ts.net", port: 49322 },
};
const inputs = {
  trustedKeys: { fixture: "pem" },
  artifacts: {
    stageId: "s1",
    gateway: {},
    assets: {},
    gatewayPath: "/nonexistent/gateway",
    assetsPath: "/nonexistent/assets",
  },
};
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw Error("Input must not be inspected.");
    },
  },
);

it("default composition attaches nothing and needs no persistence, FS or channel", async () => {
  // Absent inputs build `Layer.empty`: no SqlClient, identity, backend or channel is provided,
  // so any attempt to construct the owners store or the controller would fail this build.
  const composition = RemoteMobileActivationLive as unknown as Layer.Layer<never>;
  const acknowledgement = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteMobileGatewayActivation;
        return yield* service.activate(untouchable);
      }),
    ).pipe(Effect.provide(composition.pipe(Layer.provideMerge(RemoteMobileGatewayActivationLive)))),
  );
  expect(acknowledgement).toEqual({ requestId: null, status: "unavailable" });
  expect(seen.factories).toBe(0);
});

it("inputs present attach one controller over the app's single owners store", async () => {
  const sibling: RemoteAgentOwnerStore[] = [];
  // Another app consumer providing the same owners layer, as the local-supervisor PTY does.
  const consumer = Layer.effectDiscard(
    Effect.gen(function* () {
      sibling.push(yield* RemoteAgentRuntimeOwners);
    }),
  ).pipe(Layer.provide(RemoteAgentRuntimeOwnersLive));
  const composition = Layer.mergeAll(RemoteMobileActivationAttachLive, consumer).pipe(
    Layer.provideMerge(RemoteMobileGatewayActivationLive),
    Layer.provide(Layer.succeed(RemoteMobileNativeInputs, Option.some(inputs))),
    Layer.provide(SqlitePersistenceMemory),
  ) as unknown as Layer.Layer<RemoteMobileGatewayActivation>;
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteMobileGatewayActivation;
        return process.platform === "linux" ? undefined : yield* service.activate(request);
      }),
    ).pipe(Effect.provide(composition)),
  );
  expect(seen.factories).toBe(1);
  expect(sibling).toHaveLength(1);
  expect(seen.owners).toEqual(sibling);
  expect(seen.owners[0]).toBe(sibling[0]);
  // App scope release retires the attached controller.
  expect(seen.closes).toBe(1);
  // Off Linux the native activation pipeline is never entered.
  if (process.platform !== "linux")
    expect(result).toEqual({ requestId: null, status: "unavailable" });
});
