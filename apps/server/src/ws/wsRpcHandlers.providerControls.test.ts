import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcProviderControlsHandlers } from "./wsRpcHandlers.providerControls";
import { unavailableProviderControls } from "../provider/providerControls.ts";

const input = {
  threadId: ThreadId.makeUnsafe("chat"),
  sessionEpoch: 2,
  action: "compact" as const,
};
it("validates epoch before calling the provider, including direct handler use", async () => {
  const providerControls = vi.fn(() =>
    Effect.succeed(unavailableProviderControls(input, "disabled")),
  );
  const handler = makeWsRpcProviderControlsHandlers({
    providerService: { providerControls },
  } as unknown as WsRpcContext)[WS_METHODS.providerControls];
  await expect(
    Effect.runPromise(handler({ ...input, sessionEpoch: undefined } as never)),
  ).rejects.toThrow();
  expect(providerControls).not.toHaveBeenCalled();
  await Effect.runPromise(handler(input));
  expect(providerControls).toHaveBeenCalledWith(input);
});
it("does not expose native error payloads through the WS error", async () => {
  const providerControls = () => Effect.fail(new Error("TOKEN=secret"));
  const handler = makeWsRpcProviderControlsHandlers({
    providerService: { providerControls },
  } as unknown as WsRpcContext)[WS_METHODS.providerControls];
  const error = await Effect.runPromise(Effect.flip(handler(input)));
  expect(error.message).not.toContain("secret");
  expect(error._tag).toBe("ProviderControlsError");
});
