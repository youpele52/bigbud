import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { Effect } from "effect";
import { expect } from "vitest";

import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import type { RemoteAgentOwner } from "../../remote-agent/remoteAgentOwners.ts";
import type { OwnedPtyHostedStatus } from "../Services/OwnedPtyRuntime.ts";
import { FakeHostAdapter, flush, makeHostManager } from "./Manager.host.test.helpers.ts";
import { openInput } from "./Manager.test.helpers.ts";

const ownerKey = (terminalId: string) => `terminal:${JSON.stringify(["thread-1", terminalId])}`;

/**
 * After a backend restart in keep mode: the host still runs `kept` (no view reopened it), the
 * manager has no session for it, and the roster lists it.
 */
function keptAfterRestart(status: OwnedPtyHostedStatus = "live") {
  const adapter = new FakeHostAdapter();
  const key = ownerKey("kept");
  adapter.ownership.rows.set(key, {
    ...profileOwner(),
    ownerKey: key,
    target: "local-terminal-host",
    resourceId: "pty-kept",
    state: "may-have-been-sent",
  });
  adapter.generations.inventoryEntries = [
    {
      ptyId: "pty-kept",
      connectionId: "state-1",
      state: "running",
      lost: false,
      lifecycleManaged: true,
    },
  ];
  const closed: RemoteAgentOwner[] = [];
  Object.assign(adapter.runtime, {
    hostPtys: {
      status: async () => status,
      close: async (owner: RemoteAgentOwner) => {
        closed.push(owner);
        // The host confirmed the exit: the owner row is released and the PTY is gone.
        adapter.ownership.rows.set(owner.ownerKey, { ...owner, state: "terminal" });
        adapter.generations.inventoryEntries = [];
      },
    },
  });
  return { adapter, closed };
}

it.layer(NodeServices.layer, { excludeTestServices: true })("host roster panes on close", (it) => {
  it.effect("archiving a thread after a restart closes its kept host pane through the host", () =>
    Effect.gen(function* () {
      const { adapter, closed } = keptAfterRestart();
      const { manager } = yield* makeHostManager(adapter);
      yield* Effect.promise(flush);
      const inventories: TerminalSessionInventory[] = [];
      yield* manager.subscribe(() => Effect.void, {
        onInventory: (inventory) => Effect.sync(() => inventories.push(inventory)),
      });
      expect(inventories[0]?.sessions.map((entry) => entry.terminalId)).toEqual(["kept"]);
      // A live pane the view did reopen is closed through its session, as before.
      yield* manager.open(openInput({ terminalId: "open" }));

      yield* manager.close({ threadId: "thread-1" });
      expect(closed.map((owner) => owner.resourceId)).toEqual(["pty-kept"]);
      expect(adapter.processes[0]?.killed).toBe(true);
      yield* Effect.promise(() => new Promise((done) => setTimeout(done, 400)));
      expect(inventories.at(-1)?.sessions).toEqual([]);
    }),
  );

  it.effect("closing one kept pane by id ends its host PTY too", () =>
    Effect.gen(function* () {
      const { adapter, closed } = keptAfterRestart();
      const { manager } = yield* makeHostManager(adapter);
      yield* Effect.promise(flush);
      yield* manager.close({ threadId: "thread-1", terminalId: "kept" });
      expect(closed).toHaveLength(1);
    }),
  );

  it.effect("closes nothing when the host cannot verify a kept pane", () =>
    Effect.gen(function* () {
      const { adapter, closed } = keptAfterRestart("unknown");
      const { manager } = yield* makeHostManager(adapter);
      yield* Effect.promise(flush);
      yield* manager.open(openInput({ terminalId: "open" }));
      const result = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.flip);
      expect(result._tag).toBe("TerminalExecutionTargetError");
      expect(closed).toEqual([]);
      expect(adapter.processes[0]?.killed).toBe(false);
    }),
  );

  it.effect("a pane the host already ended is just dropped", () =>
    Effect.gen(function* () {
      const { adapter, closed } = keptAfterRestart("gone");
      const { manager } = yield* makeHostManager(adapter);
      yield* Effect.promise(flush);
      yield* manager.close({ threadId: "thread-1" });
      expect(closed).toEqual([]);
    }),
  );
});
