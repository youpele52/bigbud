import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { expect } from "vitest";

import type { AppQuitIntentRecord } from "../../lifecycle/AppQuitIntent.ts";
import type { RemoteAgentHostPolicy } from "../../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import type { PtyHostWideControl } from "../Services/PTY.ts";
import { FakeHostAdapter, flush, makeHostManager } from "./Manager.host.test.helpers.ts";

/** Remote-agent terminals only: no local host runtime. */
class RemoteOnlyAdapter extends FakeHostAdapter {
  override readonly ownedRuntimeForTarget = () => undefined;
}

/** A remote host whose kept terminals no session holds; `live` toggles its connection. */
function keptHost(key: string) {
  const host = {
    live: true,
    policies: [] as RemoteAgentHostPolicy[],
    closeAllCalls: [] as Array<{ reason: string; managedOnly: boolean }>,
    control: undefined as unknown as PtyHostWideControl,
  };
  host.control = {
    connectionKey: () => {
      if (!host.live) throw new Error("no live connection");
      return key;
    },
    updatePolicy: async (policy) => {
      host.policies.push(policy);
      return policy;
    },
    closeAll: async (input) => {
      host.closeAllCalls.push(input);
      return 2;
    },
    subscribe: async () => () => undefined,
  };
  return host;
}

const intent = (reason: AppQuitIntentRecord["reason"]) =>
  Option.some({ sequence: 1, reason, occurredAt: 1 });

it.layer(NodeServices.layer, { excludeTestServices: true })("kept remote terminals", (it) => {
  for (const [label, keep, expected] of [
    ["a default quit closes them although no session holds one", false, "quit"],
    ["keep mode leaves them running", true, undefined],
  ] as const)
    it.effect(label, () =>
      Effect.gen(function* () {
        const kept = keptHost("remote-kept");
        const offline = keptHost("remote-offline");
        offline.live = false;
        let reads = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* makeHostManager(new RemoteOnlyAdapter(), {
              keepRunningAfterQuit: () => keep,
              resolveQuitIntent: Effect.succeed(intent("quit")),
              remoteKeptTerminalHosts: async () => {
                reads += 1;
                return [kept.control, offline.control];
              },
            });
            yield* Effect.promise(flush);
            // Startup reads the owners and pushes the policy to the reachable host only.
            expect(reads).toBe(1);
            expect(kept.policies.map((policy) => policy.orphanCloseMs)).toEqual([
              keep ? 0 : 600_000,
            ]);
            expect(offline.policies).toEqual([]);
          }),
        );
        // The quit used the last read: no storage read inside the close budget.
        expect(reads).toBe(1);
        expect(kept.closeAllCalls).toEqual(
          expected ? [{ reason: expected, managedOnly: true }] : [],
        );
        expect(offline.closeAllCalls).toEqual([]);
      }),
    );
});
