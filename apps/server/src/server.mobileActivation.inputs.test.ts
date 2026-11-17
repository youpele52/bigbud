import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, it, vi } from "vitest";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { ServerConfig } from "./startup/config.ts";
import { RemoteBackendIdentityService } from "./remote-backend/identity.service.ts";
import {
  makeRemoteMobileNativeInputsLayer,
  type RemoteMobileNativeInputsValue,
} from "./remote-backend/mobileGatewayActivation.inputs.ts";
import {
  inputsAuthorityId,
  mobileInputsFixture,
} from "./remote-backend/mobileGatewayActivation.inputs.fixture.ts";
import {
  RemoteMobileGatewayActivation,
  RemoteMobileGatewayActivationLive,
} from "./remote-backend/mobileGatewayActivation.service.ts";
import { RemoteMobileActivationAttachLive } from "./server.mobileActivation.ts";

const seen = vi.hoisted(() => ({
  inputs: [] as RemoteMobileNativeInputsValue[],
  recoveries: 0,
}));
// The real controller state machine on Linux semantics; only the native pipeline is a seam.
vi.mock("./remote-backend/mobileGatewayActivation.controller.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./remote-backend/mobileGatewayActivation.controller.ts")>();
  const { Effect } = await import("effect");
  return {
    ...actual,
    makeNativeMobileActivationController: (inputs: RemoteMobileNativeInputsValue) =>
      Effect.sync(() => {
        seen.inputs.push(inputs);
        return actual.createMobileActivationController(
          async () => ({ kind: "unavailable" }),
          "linux",
          async () => {
            seen.recoveries++;
            return { kind: "none" };
          },
        );
      }),
  };
});
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  seen.inputs.length = 0;
  seen.recoveries = 0;
  await close?.();
  close = undefined;
});

const services = Layer.mergeAll(
  Layer.succeed(ServerConfig, { mode: "remote" } as never),
  Layer.succeed(RemoteBackendIdentityService, {
    authority: { authorityId: inputsAuthorityId },
  } as never),
);
const compose = (home: string) =>
  RemoteMobileActivationAttachLive.pipe(
    Layer.provideMerge(RemoteMobileGatewayActivationLive),
    Layer.provide(makeRemoteMobileNativeInputsLayer({ platform: "linux", homeDir: () => home })),
    Layer.provide(services),
    Layer.provide(SqlitePersistenceMemory),
  ) as unknown as Layer.Layer<RemoteMobileGatewayActivation>;

it("a valid owner inputs file attaches the controller and runs successor recovery once", async () => {
  const f = await mobileInputsFixture();
  close = f.close;
  await f.write();
  const status = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteMobileGatewayActivation;
        yield* Effect.promise(() => vi.waitFor(() => expect(seen.recoveries).toBe(1)));
        return yield* service.status;
      }),
    ).pipe(Effect.provide(compose(f.home))),
  );
  expect(seen.inputs).toHaveLength(1);
  expect(seen.inputs[0]!.artifacts.stageId).toBe("fixture-stage");
  expect(status.attached).toBe(true);
  expect(status.controller?.lastOutcome?.kind).toBe("none");
});

it("an invalid inputs file attaches nothing and recovers nothing", async () => {
  const f = await mobileInputsFixture();
  close = f.close;
  await f.write(f.file, 0o644);
  const status = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteMobileGatewayActivation;
        return yield* service.status;
      }),
    ).pipe(Effect.provide(compose(f.home))),
  );
  expect(status.attached).toBe(false);
  expect(seen.inputs).toHaveLength(0);
  expect(seen.recoveries).toBe(0);
});
