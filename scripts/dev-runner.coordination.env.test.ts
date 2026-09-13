import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { createDevRunnerEnv } from "./dev-runner.lib.env.ts";

it.layer(NodeServices.layer)("runner reservation identity", (it) => {
  for (const attach of [false, true]) {
    it.effect(
      `clears inherited ownership and forwards only this launch's identity (attach=${attach})`,
      () =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode: "dev:web",
            serverOffset: 7,
            webOffset: 7,
            instanceOffset: 0,
            baseEnv: {
              BIGBUD_DEV_REPO_ROOT: "/stale/root",
              BIGBUD_DEV_WEB_RESERVATION: "stale-owner",
            },
            ...(attach ? { repoRoot: "/canonical/checkout", webReservation: "current-owner" } : {}),
            t3Home: undefined,
            authToken: undefined,
            noBrowser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });
          assert.equal(env.BIGBUD_DEV_REPO_ROOT, attach ? "/canonical/checkout" : undefined);
          assert.equal(env.BIGBUD_DEV_WEB_RESERVATION, attach ? "current-owner" : undefined);
          assert.equal(env.BIGBUD_DEV_WEB_PORT, "5740");
          assert.equal(env.BIGBUD_DEV_INSTANCE_OFFSET, "0");
          assert.equal(env.MOBILE_WEB_PORT, "5740");
          assert.equal(env.VITE_MOBILE_WEB_URL, undefined);
        }),
    );
  }
});
