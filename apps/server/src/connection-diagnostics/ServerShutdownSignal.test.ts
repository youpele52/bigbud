import { readFileSync } from "node:fs";

import { Effect, Layer, PubSub, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import { DesktopSupervisorDeliveryLive } from "../desktop-supervisor/desktopSupervisorDelivery.layer.ts";
import { DesktopSupervisorDelivery } from "../desktop-supervisor/desktopSupervisorDelivery.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeOrchestrationDeliveryStream } from "../ws/wsOrchestrationDelivery.ts";
import { makeConnectionDiagnostics } from "./Layers/ConnectionDiagnostics.ts";
import { withServerShutdownSignal } from "./Layers/ServerShutdownSignal.ts";
import { ConnectionDiagnostics } from "./Services/ConnectionDiagnostics.ts";

const emptyReplay = (fromSequenceExclusive: number) => ({
  requestedFromSequenceExclusive: fromSequenceExclusive,
  retainedFromSequenceExclusive: fromSequenceExclusive,
  earliestAvailableSequence: null,
  latestSequence: fromSequenceExclusive,
  availability: "available" as const,
  complete: true,
  events: [],
});

function engine(liveEvents: PubSub.PubSub<OrchestrationEvent>) {
  return {
    getReadModel: () => Effect.succeed({ snapshotSequence: 0 }),
    readEvents: () => Stream.empty,
    readReplay: (fromSequenceExclusive: number) =>
      Effect.succeed(emptyReplay(fromSequenceExclusive)),
    streamDomainEvents: Stream.fromPubSub(liveEvents),
  } as unknown as OrchestrationEngineShape;
}

/**
 * Stands in for the HTTP routes: holds one orchestration delivery stream in its
 * own scope, wired exactly like the `subscribeOrchestrationDomainEvents` handler.
 */
const RoutesWithOpenDeliveryStream = Layer.effectDiscard(
  Effect.gen(function* () {
    const delivery = yield* DesktopSupervisorDelivery;
    const diagnostics = yield* ConnectionDiagnostics;
    const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const stream = yield* makeOrchestrationDeliveryStream({
      consumerId: "consumer-shutdown",
      appliedSequence: 0,
      orchestrationEngine: engine(liveEvents),
      delivery,
      onSessionEnded: diagnostics.recordDeliverySessionEnded,
      isServerShuttingDown: diagnostics.isServerShuttingDown,
    });
    yield* Stream.runDrain(stream).pipe(Effect.forkScoped);
  }),
);

/** Builds the server-shaped layer stack, lets it run briefly, then closes its scope. */
async function endReasonsAfterTeardown(options: { readonly withSignal: boolean }) {
  const diagnostics = makeConnectionDiagnostics();
  const runtimeServices = Layer.mergeAll(
    DesktopSupervisorDeliveryLive,
    Layer.succeed(ConnectionDiagnostics, diagnostics),
  );
  const application = options.withSignal
    ? withServerShutdownSignal(RoutesWithOpenDeliveryStream)
    : RoutesWithOpenDeliveryStream;
  const server = application.pipe(Layer.provideMerge(runtimeServices));
  await Effect.runPromise(
    Effect.scoped(Layer.build(server).pipe(Effect.andThen(Effect.sleep("20 millis")))),
  );
  const snapshot = await Effect.runPromise(diagnostics.snapshot());
  return {
    shuttingDown: diagnostics.isServerShuttingDown(),
    reasons: snapshot.serverEvents.flatMap((event) =>
      event.type === "delivery-session-ended" ? [event.reason] : [],
    ),
  };
}

describe("server shutdown signal", () => {
  beforeEach(() => {
    vi.stubEnv("BIGBUD_DESKTOP_SUPERVISOR_ENABLED", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records a delivery stream closed by full server teardown as a server shutdown", async () => {
    const result = await endReasonsAfterTeardown({ withSignal: true });

    expect(result.shuttingDown).toBe(true);
    expect(result.reasons).toEqual(["server-shutdown"]);
  });

  it("would read as a client close without the signal, because routes close first", async () => {
    const result = await endReasonsAfterTeardown({ withSignal: false });

    expect(result.shuttingDown).toBe(false);
    expect(result.reasons).toEqual(["client-close"]);
  });

  it("is wired around the real routes in makeServerLayer, inside the runtime services", () => {
    // Layers are opaque at runtime and the real server layer opens SQLite and binds a
    // port, so this guards the composition in server.ts itself against a reorder.
    const source = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const makeServerLayer = source.slice(source.indexOf("export const makeServerLayer"));
    const application = makeServerLayer.slice(
      makeServerLayer.indexOf("const serverApplicationLayer"),
      makeServerLayer.indexOf("return "),
    );

    expect(application).toContain("HttpRouter.serve(makeRoutesLayer");
    expect(makeServerLayer).toMatch(
      /return withServerShutdownSignal\(serverApplicationLayer\)\.pipe\(\s*(?:\/\/[^\n]*\n\s*)*Layer\.provideMerge\(RuntimeServicesLive\)/,
    );
  });
});
