import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
vi.mock("./identity.service.ts", async (original) => {
  const actual = await original<typeof import("./identity.service.ts")>();
  const { BackendInstance } = await import("../startup/backendInstance.ts");
  const { loadRemoteBackendIdentity } = await import("./authority.ts");
  return {
    ...actual,
    makeRemoteBackendIdentityLive: (options: { requireExisting?: boolean } = {}) =>
      Layer.effect(
        actual.RemoteBackendIdentityService,
        Effect.gen(function* () {
          const owner = yield* BackendInstance;
          return yield* Effect.promise(() =>
            loadRemoteBackendIdentity({ ...owner, machineId: "machine-v1:setup-fixture" }, options),
          );
        }),
      ),
  };
});
// Host eligibility only is injected: all remote auth/config constraints remain real.
vi.mock("../startup/config.remote.ts", async (original) => {
  const actual = await original<typeof import("../startup/config.remote.ts")>();
  return {
    ...actual,
    assertRemoteServerProfile: (config: Parameters<typeof actual.assertRemoteServerProfile>[0]) =>
      actual.assertRemoteServerProfile(config, "linux"),
  };
});
