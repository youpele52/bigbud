/**
 * Shared harness for end-to-end tests through the Rust mobile gateway binary,
 * against an isolated backend (temporary state, no live account). Tests using
 * it run only when `BIGBUD_MOBILE_GATEWAY_BIN` points at a built gateway.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { Effect, Layer } from "effect";

import { MOBILE_GATEWAY_CREDENTIAL_ENV } from "./mobile/mobileGatewayCredential.ts";
import { MobileRemoteControlLive } from "./mobile/Layers/MobileRemoteControl.ts";
import { MobileRemoteControl } from "./mobile/Services/MobileRemoteControl.ts";
import { buildTestServerConfig } from "./server.test.app.config.ts";
import { ServerConfig } from "./startup/config.ts";
import { ServerSettingsService } from "./ws/serverSettings.ts";

export const GATEWAY_BIN = process.env.BIGBUD_MOBILE_GATEWAY_BIN;
export const EXTERNAL_HOST = "desk.tail1.ts.net";

export const realMobileRemoteControl = Effect.gen(function* () {
  return yield* MobileRemoteControl;
}).pipe(
  Effect.provide(
    MobileRemoteControlLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(ServerConfig, buildTestServerConfig()),
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              mobileRemoteControl: {
                ...DEFAULT_SERVER_SETTINGS.mobileRemoteControl,
                enabled: true,
              },
            }),
          }),
        ),
      ),
    ),
  ),
);

export function startGateway(backendPort: number, credential: string, listen = "127.0.0.1:0") {
  return Effect.acquireRelease(
    Effect.callback<{ readonly child: ChildProcess; readonly port: number }, Error>((resume) => {
      const child = spawn(
        GATEWAY_BIN ?? "",
        [
          "--listen",
          listen,
          "--upstream",
          `127.0.0.1:${backendPort}`,
          "--external-origin",
          `https://${EXTERNAL_HOST}`,
        ],
        {
          env: { ...process.env, [MOBILE_GATEWAY_CREDENTIAL_ENV]: credential },
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
      child.once("error", (error) => resume(Effect.fail(error)));
      createInterface({ input: child.stdout! }).once("line", (line) => {
        const ready = JSON.parse(line) as { listen: string };
        resume(Effect.succeed({ child, port: Number(ready.listen.split(":").at(-1)) }));
      });
    }),
    ({ child }) => Effect.sync(() => child.kill()),
  );
}

export const fetchEffect = (url: string, init?: RequestInit) =>
  Effect.promise(() =>
    fetch(url, init).then(async (response) => ({
      status: response.status,
      body: await response.text(),
    })),
  );

/**
 * A fresh gateway credential, exported to this process for the backend's
 * guard and restored when the test's scope closes.
 */
export const withGatewayCredential = Effect.gen(function* () {
  const credential = randomBytes(24).toString("hex");
  const previous = process.env[MOBILE_GATEWAY_CREDENTIAL_ENV];
  process.env[MOBILE_GATEWAY_CREDENTIAL_ENV] = credential;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previous === undefined) delete process.env[MOBILE_GATEWAY_CREDENTIAL_ENV];
      else process.env[MOBILE_GATEWAY_CREDENTIAL_ENV] = previous;
    }),
  );
  return credential;
});
