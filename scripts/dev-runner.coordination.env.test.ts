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
              BIGBUD_DEV_RUNNER_PID: "1",
            },
            ...(attach
              ? {
                  repoRoot: "/canonical/checkout",
                  webReservation: "current-owner",
                  runnerPid: 4_242,
                }
              : {}),
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
          // dev:web never exports it: only dev:desktop's launcher may end the session.
          assert.equal(env.BIGBUD_DEV_RUNNER_PID, undefined);
          assert.equal(env.BIGBUD_DEV_WEB_PORT, "5740");
          assert.equal(env.BIGBUD_DEV_INSTANCE_OFFSET, "0");
          assert.equal(env.MOBILE_WEB_PORT, "5740");
          assert.equal(env.VITE_MOBILE_WEB_URL, undefined);
        }),
    );
  }

  it.effect("exports the runner PID for dev:desktop only", () =>
    Effect.gen(function* () {
      const make = (mode: "dev" | "dev:desktop") =>
        createDevRunnerEnv({
          mode,
          serverOffset: 0,
          webOffset: 0,
          baseEnv: { BIGBUD_DEV_RUNNER_PID: "1" },
          runnerPid: 4_242,
          t3Home: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });
      assert.equal((yield* make("dev:desktop")).BIGBUD_DEV_RUNNER_PID, "4242");
      assert.equal((yield* make("dev")).BIGBUD_DEV_RUNNER_PID, undefined);
    }),
  );
});
