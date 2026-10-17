import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CopilotAdapter } from "../../Services/Copilot/Adapter.ts";
import { makeCopilotAdapterLive } from "./Adapter.ts";

describe("CopilotAdapter session lookup before dispatch", () => {
  it.effect("a turn for a thread without a session fails session-dead (nothing written)", () => {
    const clientFactory = vi.fn(() => ({}) as never);
    const layer = makeCopilotAdapterLive({ clientFactory }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/copilot-lookup-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const adapter = yield* CopilotAdapter;
      const error = yield* Effect.flip(
        adapter.sendTurn({ threadId: ThreadId.makeUnsafe("thread-missing"), input: "hi" }),
      );
      assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
      expect(error).toMatchObject({ failureClass: "session-dead" });
      expect(clientFactory).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });
});
