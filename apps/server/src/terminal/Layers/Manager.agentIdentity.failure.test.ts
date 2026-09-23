import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { TerminalAgentInspectionError } from "./Manager.agentDetection";
import { createManager, openInput, waitFor } from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager", (it) => {
  it.effect(
    "preserves identity when process inspection fails and clears it after shell detection",
    () =>
      Effect.gen(function* () {
        let detectedAgent: "pi" | null = "pi";
        let inspectionFails = false;
        let failedScans = 0;
        const { manager, getEvents } = yield* createManager(5, {
          agentDetector: (pids) => {
            if (inspectionFails) {
              failedScans += 1;
              return Effect.fail(
                new TerminalAgentInspectionError({ message: "simulated process scan failure" }),
              );
            }
            return Effect.succeed(new Map(pids.map((pid) => [pid, detectedAgent])));
          },
          subprocessPollIntervalMs: 20,
        });

        yield* manager.open(openInput());
        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some((event) => event.type === "agentIdentity" && event.provider === "pi"),
          ),
          "1200 millis",
        );

        inspectionFails = true;
        yield* waitFor(
          Effect.sync(() => failedScans >= 3),
          "1200 millis",
        );
        expect(
          (yield* getEvents)
            .filter((event) => event.type === "agentIdentity")
            .map((event) => event.provider),
        ).toEqual(["pi"]);

        inspectionFails = false;
        detectedAgent = null;
        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some((event) => event.type === "agentIdentity" && event.provider === null),
          ),
          "1200 millis",
        );
        expect(
          (yield* getEvents)
            .filter((event) => event.type === "agentIdentity")
            .map((event) => event.provider),
        ).toEqual(["pi", null]);
      }),
  );
});
