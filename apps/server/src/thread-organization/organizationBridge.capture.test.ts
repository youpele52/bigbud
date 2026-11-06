import { assert, it } from "@effect/vitest";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeOrchestrationDeliveryHub } from "../orchestration/Layers/OrchestrationEngine.deliveryHub.ts";
import { consumeOrganizationCapture } from "./organizationBridge.capture.ts";
import {
  OrganizationResync,
  runOrganizationLifecycle,
  type OrganizationAutomationStatus,
} from "./organizationLifecycle.ts";
import { OrganizationObservation } from "./organizationObservation.ts";

const event = (value: object) => value as unknown as OrchestrationEvent;
const activity = (threadId: string) =>
  event({
    type: "thread.activity-appended",
    aggregateKind: "thread",
    aggregateId: threadId,
    payload: { threadId, activity: { kind: "tool.completed" } },
  });

it.effect("a real live-capture overflow reaches the lifecycle as a resync, never paused", () =>
  Effect.gen(function* () {
    const hub = yield* makeOrchestrationDeliveryHub;
    let attempts = 0;
    const statuses: OrganizationAutomationStatus[] = [];
    // Each attempt opens a capture of two events and is flooded before it is consumed.
    const run = Effect.gen(function* () {
      attempts += 1;
      const capture = yield* hub.openCapture(2);
      for (let index = 0; index < 3; index++) yield* hub.publish(activity(`thread-${index}`));
      return yield* consumeOrganizationCapture({
        stream: capture.stream,
        isOverflowed: capture.isOverflowed,
        observations: new OrganizationObservation(),
      });
    }).pipe(Effect.flatMap(() => Effect.never));
    const failure = yield* Effect.flip(
      Effect.scoped(
        Effect.gen(function* () {
          const capture = yield* hub.openCapture(2);
          for (let index = 0; index < 3; index++) yield* hub.publish(activity(`direct-${index}`));
          return yield* consumeOrganizationCapture({
            stream: capture.stream,
            isOverflowed: capture.isOverflowed,
            observations: new OrganizationObservation(),
          });
        }),
      ),
    );
    assert.instanceOf(failure, OrganizationResync);
    const fiber = yield* Effect.forkScoped(
      runOrganizationLifecycle({ run, status: (value) => void statuses.push(value) }),
    );
    // Resync spacing 2s, 4s, 8s: four attempts in 15s and no failure-budget latch.
    yield* TestClock.adjust("15 seconds");
    assert.equal(attempts, 4);
    assert.notInclude(statuses, "paused");
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("capture faults other than overflow stay real faults; an ended capture resyncs", () =>
  Effect.gen(function* () {
    const faulted = yield* Effect.flip(
      consumeOrganizationCapture({
        stream: Stream.die(new Error("hub broke")),
        isOverflowed: Effect.succeed(false),
        observations: new OrganizationObservation(),
      }),
    );
    assert.isFalse(faulted instanceof OrganizationResync);
    assert.equal(faulted.message, "hub broke");
    const observations = new OrganizationObservation();
    let hints = 0;
    const ended = yield* Effect.flip(
      consumeOrganizationCapture({
        stream: Stream.make(
          activity("busy"),
          event({
            type: "thread.organization-updated",
            aggregateKind: "thread",
            aggregateId: "moved",
            payload: { threadId: "moved", source: "deliberate" },
          }),
          event({
            type: "thread.organization-updated",
            aggregateKind: "thread",
            aggregateId: "auto",
            payload: { threadId: "auto", automaticMove: { operationId: "op" } },
          }),
        ),
        isOverflowed: Effect.succeed(false),
        observations,
        onDeliberateOrganization: () => void (hints += 1),
      }),
    );
    assert.instanceOf(ended, OrganizationResync);
    // Only the deliberate update hints a barrier read; every thread is marked.
    assert.equal(hints, 1);
    assert.equal(observations.size, 3);
  }),
);
