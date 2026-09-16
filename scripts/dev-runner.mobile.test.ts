import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MOBILE_WEB_PORT, DEFAULT_WEB_PORT } from "@bigbud/shared/DevPorts";

import { createDevRunnerEnv, resolveModePortOffsets } from "./dev-runner.ts";

describe("mobile development port wiring", () => {
  it.effect("keeps the companion URL at the instance offset when the web port shifts", () =>
    Effect.gen(function* () {
      const offsets = yield* resolveModePortOffsets({
        mode: "dev:desktop",
        startOffset: 0,
        hasExplicitServerPort: false,
        hasExplicitDevUrl: false,
        checkPortAvailability: (port) => Effect.succeed(port !== DEFAULT_WEB_PORT),
      });

      assert.deepStrictEqual(offsets, {
        serverOffset: 1,
        webOffset: 1,
      });
    }),
  );

  it.effect("does not preselect a mobile port when the sibling web shifts to 5740", () =>
    Effect.gen(function* () {
      const offsets = yield* resolveModePortOffsets({
        mode: "dev:desktop",
        startOffset: 0,
        hasExplicitServerPort: false,
        hasExplicitDevUrl: false,
        checkPortAvailability: (port) =>
          Effect.succeed(port < DEFAULT_WEB_PORT || port >= DEFAULT_MOBILE_WEB_PORT),
      });
      assert.deepStrictEqual(offsets, { serverOffset: 7, webOffset: 7 });
    }),
  );
  it.effect("leaves mobile allocation to the actual listener without probing", () =>
    Effect.gen(function* () {
      const offsets = yield* resolveModePortOffsets<never>({
        mode: "dev:mobile-web",
        startOffset: 4,
        hasExplicitServerPort: false,
        hasExplicitDevUrl: false,
        checkPortAvailability: () => {
          throw new Error("Mobile allocation must not use preflight probes");
        },
      });
      assert.deepStrictEqual(offsets, { serverOffset: 4, webOffset: 4 });
    }),
  );
});

it.layer(NodeServices.layer)("mobile listener environment", (it) => {
  for (const mode of ["dev", "dev:desktop", "dev:web", "dev:mobile-web"] as const) {
    it.effect(`${mode} shares discovery identity without advertising a predicted port`, () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode,
          baseEnv: { VITE_MOBILE_WEB_URL: "http://localhost:9999", BIGBUD_DEV_WEB_PORT: "9999" },
          serverOffset: 12,
          webOffset: 14,
          instanceOffset: 10,
          t3Home: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });
        assert.equal(env.MOBILE_WEB_PORT, "5750");
        assert.equal(env.BIGBUD_DEV_INSTANCE_OFFSET, "10");
        assert.equal(env.VITE_MOBILE_WEB_URL, undefined);
        assert.equal(env.BIGBUD_DEV_WEB_PORT, mode === "dev:mobile-web" ? undefined : "5747");
        assert.equal(env.PORT, mode === "dev:mobile-web" ? "5750" : "5747");
      }),
    );
  }
});
