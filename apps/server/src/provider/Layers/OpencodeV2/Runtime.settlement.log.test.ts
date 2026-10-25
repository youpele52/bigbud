import { Effect, Layer, Logger, References, ServiceMap } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import {
  bindV2SettlementLogServices,
  logV2SettlementDiagnostic,
} from "./Runtime.settlement.log.ts";

const serverLayer = (messages: unknown[], level: "Debug" | "Error") =>
  Layer.mergeAll(
    Logger.layer([Logger.make(({ message }) => void messages.push(message))], {
      mergeWithExisting: false,
    }),
    Layer.succeed(References.MinimumLogLevel, level),
  );

/** Binds the services of a server-like layer exactly as `makeV2RuntimeAdapter` does. */
const bindFrom = (layer: Layer.Layer<never>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      bindV2SettlementLogServices(yield* Effect.services());
    }).pipe(Effect.provide(layer)),
  );

afterEach(() => bindV2SettlementLogServices(ServiceMap.empty()));

it("routes settlement diagnostics through the bound server logger", async () => {
  const messages: unknown[] = [];
  await bindFrom(serverLayer(messages, "Debug"));
  logV2SettlementDiagnostic("OpenCode v2 execution settlement held", { reason: "coding-busy" });
  await vi.waitFor(() =>
    expect(messages).toEqual([
      ["OpenCode v2 execution settlement held", { reason: "coding-busy" }],
    ]),
  );
});

it("honors the bound server minimum log level", async () => {
  const messages: unknown[] = [];
  await bindFrom(serverLayer(messages, "Error"));
  logV2SettlementDiagnostic("OpenCode v2 execution settlement held", { reason: "coding-busy" });
  await new Promise((resolve) => setImmediate(resolve));
  expect(messages).toEqual([]);
});
