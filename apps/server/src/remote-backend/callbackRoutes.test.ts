import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { expect, it } from "vitest";

import { RemoteCallbackRoutesLive } from "../server.remote.callbacks.ts";
import { ServerConfig } from "../startup/config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

it("keeps client WebSocket, handshake, mobile and attachment routes off the callback listener", async () => {
  const app = HttpRouter.toWebHandler(
    RemoteCallbackRoutesLive.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          ServerConfig.layerTest("/tmp/callback-fixture", "/tmp/callback-fixture"),
          Layer.mock(OrchestrationEngineService)({}),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );
  try {
    for (const path of [
      "/ws?token=any-client-token",
      "/api/remote-backend/handshake",
      "/mobile-ws",
      "/attachments/private",
    ]) {
      const response = await app.handler(
        new Request(`http://callback.invalid${path}`, {
          headers: { authorization: "Bearer any-client-token", upgrade: "websocket" },
        }),
      );
      expect(response.status, path).toBe(404);
    }
    const response = await app.handler(
      new Request("http://callback.invalid/api/internal/thread-tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list_threads" }),
      }),
    );
    // Before a dispatcher is installed, callback admission is unavailable rather than unguarded.
    expect(response.status).toBe(503);
  } finally {
    await app.dispose();
  }
});
