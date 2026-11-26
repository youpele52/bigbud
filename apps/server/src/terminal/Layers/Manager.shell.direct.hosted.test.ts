/**
 * Plan M7 with a fake host: Direct SSH panes run in the local terminal host, recorded with their
 * SSH target. Thread delete closes them through the existing close path (also when no session
 * holds them after a backend restart), an unreachable host blocks deletion, and Forget closes a
 * live PTY before removing its record.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";

import { fixture, owner } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { FakeHostAdapter, flush, makeHostManager } from "./Manager.host.test.helpers.ts";
import {
  DirectSshHostAdapter,
  OTHER_SSH_TARGET,
  SSH_TARGET,
  sshPane,
} from "./Manager.shell.direct.hosted.test.helpers.ts";

vi.mock("../../ssh/sshProcess", () => ({
  runSshCommand: vi.fn(async (input: { args: string[] }) => ({
    stdout: `\x1e${input.args[3]}\x1f`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));

const key = directShellOwnerKey("thread-1", "ssh");

const setup = Effect.fn("test.directSshHost")(function* () {
  const db = yield* Effect.promise(fixture);
  const adapter = new DirectSshHostAdapter();
  const first = yield* makeHostManager(adapter, { directShellOwners: db.store });
  yield* first.manager.open(sshPane());
  const process = yield* adapter.processAt(0);
  // A second backend over the same host and journal: the pane is not reopened (a restart).
  const restarted = () =>
    makeHostManager(adapter, { directShellOwners: db.store }).pipe(Effect.map((m) => m.manager));
  return { db, adapter, manager: first.manager, process, restarted };
});

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "Direct SSH in the local host",
  (it) => {
    it.effect("runs the pane in the host, recorded with its target and owner-hinted", () =>
      Effect.gen(function* () {
        const { db, adapter, process } = yield* setup();
        const [spawn] = adapter.hostSpawns();
        expect(spawn).toMatchObject({ executionTargetId: SSH_TARGET, shell: "ssh" });
        expect(spawn?.ownerKey).toBe(JSON.stringify(["thread-1", "ssh"]));
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toMatchObject({
          executionTargetId: SSH_TARGET,
          pane: { threadId: "thread-1", terminalId: "ssh" },
        });
        yield* Effect.promise(flush);
        // Until remote inspection says otherwise, the host must treat the pane as busy.
        expect(process.viewStates.at(-1)?.ownerBusyHint).toBe("unknown");
      }),
    );

    it.effect("thread delete closes a live pane through the close path and drops its record", () =>
      Effect.gen(function* () {
        const { db, adapter, manager, process } = yield* setup();
        yield* manager.close({ threadId: "thread-1", deleteHistory: true });
        expect(process.killed).toBe(true);
        expect(adapter.clientCloses).toEqual([]);
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toBeUndefined();
      }),
    );

    it.effect("after a restart, delete closes a pane no session holds through the host", () =>
      Effect.gen(function* () {
        const { db, adapter, process, restarted } = yield* setup();
        const manager = yield* restarted();
        yield* manager.close({ threadId: "thread-1", deleteHistory: true });
        expect(adapter.clientCloses).toEqual([process.remoteResourceId]);
        expect(process.killed).toBe(true);
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toBeUndefined();
      }),
    );

    it.effect(
      "an unreachable host blocks deletion; Forget drops the record; delete then runs",
      () =>
        Effect.gen(function* () {
          const { db, adapter, process, restarted } = yield* setup();
          const manager = yield* restarted();
          adapter.unreachable = true;
          const blocked = yield* manager
            .close({ threadId: "thread-1", deleteHistory: true })
            .pipe(Effect.result);
          expect(blocked._tag).toBe("Failure");
          expect(process.killed).toBe(false);
          expect(yield* manager.retainedShellOwners!({ threadId: "thread-1" })).toEqual({
            hosts: ["devbox"],
            count: 1,
          });
          expect(yield* manager.forgetRetainedShellOwners!({ threadId: "thread-1" })).toEqual({
            forgotten: 1,
          });
          expect(yield* Effect.promise(() => db.store.getHosted!(key))).toBeUndefined();
          yield* manager.close({ threadId: "thread-1", deleteHistory: true });
        }),
    );

    it.effect("a single close of an unreachable pane fails and closes nothing", () =>
      Effect.gen(function* () {
        const { adapter, process, restarted } = yield* setup();
        const manager = yield* restarted();
        adapter.unreachable = true;
        const result = yield* manager
          .close({ threadId: "thread-1", terminalId: "ssh" })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(process.killed).toBe(false);
      }),
    );

    it.effect("Forget closes a PTY the host reports live before removing its record", () =>
      Effect.gen(function* () {
        const { db, adapter, process, restarted } = yield* setup();
        const manager = yield* restarted();
        expect(yield* manager.forgetRetainedShellOwners!({ threadId: "thread-1" })).toEqual({
          forgotten: 1,
        });
        expect(adapter.clientCloses).toEqual([process.remoteResourceId]);
        expect(process.killed).toBe(true);
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toBeUndefined();
      }),
    );

    it.effect("a pane recorded for one SSH host never attaches on another", () =>
      Effect.gen(function* () {
        const { adapter, restarted } = yield* setup();
        const manager = yield* restarted();
        const spawns = adapter.spawnInputs.length;
        const snapshot = yield* manager
          .open(sshPane({ executionTargetId: OTHER_SSH_TARGET }))
          .pipe(Effect.result);
        expect(snapshot._tag === "Failure" || snapshot.success.status === "error").toBe(true);
        expect(adapter.spawnInputs.length).toBe(spawns);
      }),
    );

    it.effect("a record whose session the host proves gone binds nothing", () =>
      Effect.gen(function* () {
        const { db, adapter, process, restarted } = yield* setup();
        // A default quit closed it in the host while no backend observed the exit.
        process.killed = true;
        const manager = yield* restarted();
        const snapshot = yield* manager.open(sshPane({ executionTargetId: OTHER_SSH_TARGET }));
        expect(snapshot.status).toBe("running");
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toMatchObject({
          executionTargetId: OTHER_SSH_TARGET,
        });
        expect(adapter.hostSpawns().at(-1)?.executionTargetId).toBe(OTHER_SSH_TARGET);
      }),
    );

    it.effect("without a host runtime for the target, nothing is recorded (flag off)", () =>
      Effect.gen(function* () {
        const db = yield* Effect.promise(fixture);
        const adapter = new FakeHostAdapter();
        const { manager } = yield* makeHostManager(adapter, { directShellOwners: db.store });
        yield* manager.open(sshPane());
        expect(adapter.spawnInputs[0]?.executionTargetId).toBe(SSH_TARGET);
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toBeUndefined();
        yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      }),
    );

    it.effect("a legacy record still blocks before any hosted pane is closed (N8 intact)", () =>
      Effect.gen(function* () {
        const { db, process, restarted } = yield* setup();
        const legacy = {
          ...owner("legacy"),
          ownerKey: directShellOwnerKey("thread-1", "old"),
          pane: { threadId: "thread-1", terminalId: "old" },
        };
        yield* Effect.promise(() => db.store.reserve(legacy));
        const manager = yield* restarted();
        const blocked = yield* manager
          .close({ threadId: "thread-1", deleteHistory: true })
          .pipe(Effect.result);
        expect(blocked._tag).toBe("Failure");
        expect(process.killed).toBe(false);
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toBeDefined();
      }),
    );
  },
);
