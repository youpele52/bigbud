import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { fixture, owner } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { FakeHostAdapter, makeHostManager } from "./Manager.host.test.helpers.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "pane identity for direct-shell deletion guards (N8)",
  (it) => {
    it.effect(
      "a host-backed pane with no history still blocks deletion by its direct-shell owner",
      () =>
        Effect.gen(function* () {
          const db = yield* Effect.promise(fixture);
          // A legacy direct-shell record for pane "host-pane", which has no history file and no
          // session: only the host's durable owner row knows the pane belongs to thread-1.
          const legacy = {
            ...owner("legacy"),
            ownerKey: directShellOwnerKey("thread-1", "host-pane"),
          };
          yield* Effect.promise(() => db.store.reserve(legacy));
          const adapter = new FakeHostAdapter();
          const ownerKey = `terminal:${JSON.stringify(["thread-1", "host-pane"])}`;
          adapter.ownership.rows.set(ownerKey, {
            ...profileOwner(),
            ownerKey,
            target: "local-terminal-host",
            resourceId: "pty-host",
            state: "may-have-been-sent",
          });
          const { manager } = yield* makeHostManager(adapter, { directShellOwners: db.store });

          const retained = yield* manager.retainedShellOwners!({ threadId: "thread-1" });
          expect(retained.count).toBe(1);
          const blocked = yield* manager
            .close({ threadId: "thread-1", deleteHistory: true })
            .pipe(Effect.result);
          expect(blocked._tag).toBe("Failure");
        }),
    );

    it.effect("an unreadable host owner table counts as unknown, never as no panes", () =>
      Effect.gen(function* () {
        const db = yield* Effect.promise(fixture);
        const legacy = { ...owner("legacy"), ownerKey: directShellOwnerKey("thread-1", "x") };
        yield* Effect.promise(() => db.store.reserve(legacy));
        const adapter = new FakeHostAdapter();
        Object.assign(adapter.ownership.store, {
          listTerminalOwners: async () => {
            throw new Error("database locked");
          },
        });
        const { manager } = yield* makeHostManager(adapter, { directShellOwners: db.store });
        const result = yield* manager.retainedShellOwners!({ threadId: "thread-1" }).pipe(
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  },
);
