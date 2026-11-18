import { METADATA_WARNING_WS_METHODS as methods } from "@bigbud/contracts/server/metadataWarnings.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it, vi } from "vitest";

import { createMetadataWarningRpcMethods } from "./wsRpcClient.metadataWarnings";
import type { WsTransport } from "./wsTransport";

it("routes warning claims and acknowledgments through the existing authenticated transport", async () => {
  const claim = vi.fn(() => Effect.succeed([]));
  const acknowledge = vi.fn(() => Effect.succeed(true));
  const transport = {
    request: vi.fn((call: (client: unknown) => Effect.Effect<unknown>) =>
      Effect.runPromise(
        call({
          [methods.claim]: claim,
          [methods.acknowledge]: acknowledge,
        }),
      ),
    ),
  } as unknown as WsTransport;
  const api = createMetadataWarningRpcMethods(transport);
  await expect(api.claimMetadataWarnings({ clientId: "renderer" })).resolves.toEqual([]);
  await expect(
    api.acknowledgeMetadataWarning({ clientId: "renderer", warningId: "warning" }),
  ).resolves.toBe(true);
  expect(claim).toHaveBeenCalledExactlyOnceWith({ clientId: "renderer" });
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith({
    clientId: "renderer",
    warningId: "warning",
  });
  expect(transport.request).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(transport.request).mock.calls) {
    const timeout = call[1]?.timeout;
    expect(timeout && Option.isSome(timeout)).toBe(true);
    expect(Duration.toMillis(Duration.fromInputUnsafe(Option.getOrThrow(timeout!)))).toBe(10_000);
  }
});
