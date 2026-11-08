import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";

import {
  makeRemoteAgentMaintenance,
  registerRemoteAgentUpdateTrigger,
} from "./remoteAgentInstall.maintenance.ts";
import {
  configureSshTargetDisconnects,
  markSshTargetDisconnected,
} from "../ssh/sshTargetDisconnects.ts";

const cleanup = vi.hoisted(() => vi.fn(async (_target: string) => undefined));
vi.mock("./remoteAgentInstallManager.ts", () => ({
  makeRemoteAgentInstallManager: () => ({ cleanup }),
}));

const flagged = "ssh:host=flagged&transport=agent";
const connected = "ssh:host=connected&transport=agent";

afterEach(() => {
  cleanup.mockClear();
  configureSshTargetDisconnects(undefined, []);
});

it.effect("skips binary cleanup for a disconnected target and still releases its slot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.promise(() => markSshTargetDisconnected(flagged));
      const released: string[] = [];
      const unregister = registerRemoteAgentUpdateTrigger((target) => released.push(target));
      yield* Effect.addFinalizer(() => Effect.sync(unregister));
      const maintenance = yield* makeRemoteAgentMaintenance;

      maintenance.schedule(flagged);
      maintenance.schedule(connected);
      yield* TestClock.adjust("2 seconds");
      for (let turn = 0; turn < 20 && released.length < 2; turn += 1) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
        yield* TestClock.adjust("2 seconds");
      }

      assert.deepEqual(
        cleanup.mock.calls.map(([target]) => target),
        [connected],
      );
      assert.deepEqual(released.toSorted(), [connected, flagged].toSorted());
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);
