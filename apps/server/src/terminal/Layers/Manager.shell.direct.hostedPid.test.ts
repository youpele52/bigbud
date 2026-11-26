/**
 * M7 follow-up: a hosted Direct SSH record stores the remote shell PID printed at launch, so a PTY
 * reattached after a backend restart still gets real owner busy hints instead of `unknown`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";

import { fixture } from "../../persistence/Layers/DirectShellLaunchOwners.test.helpers";
import { directShellOwnerKey } from "./DirectShellLaunch.owner";
import { hostedDirectShellOwner } from "./DirectShellLaunch.hosted";
import { flush } from "./Manager.host.test.helpers.ts";
import { remoteShellPidPrefix } from "./Manager.remote-identity.ts";
import { trackHostedDirectShellRecord } from "./Manager.shell.direct.hostedPid.ts";
import { SSH_TARGET } from "./Manager.shell.direct.hosted.test.helpers.ts";
import { FakePtyProcess } from "./Manager.test.helpers.ts";

const key = directShellOwnerKey("thread-1", "ssh");
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 100 && !(await check()); attempt++) await flush();
};

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "hosted Direct SSH remote shell PID",
  (it) => {
    it.effect("clears a stale PID when a fresh PTY starts under a kept record", () =>
      Effect.gen(function* () {
        const db = yield* Effect.promise(fixture);
        const stored = (yield* Effect.promise(() =>
          db.store.reserveHosted!(
            hostedDirectShellOwner({
              threadId: "thread-1",
              terminalId: "ssh",
              executionTargetId: SSH_TARGET,
            }),
          ),
        )).owner;
        const withPid = yield* Effect.promise(() => db.store.setHostedRemoteShellPid!(stored, 77));
        expect(withPid?.remoteShellPid).toBe(77);
        // A stale copy changes nothing.
        expect(
          yield* Effect.promise(() => db.store.setHostedRemoteShellPid!(stored, 78)),
        ).toBeUndefined();

        const process = new FakePtyProcess(1);
        const session = { runtimeGeneration: "00000000-0000-4000-8000-000000000000" };
        const store = {
          releaseHosted: db.store.releaseHosted!,
          setHostedRemoteShellPid: db.store.setHostedRemoteShellPid!,
        };
        trackHostedDirectShellRecord({ store, record: withPid!, process, session });
        yield* Effect.promise(() =>
          waitFor(async () => (await db.store.getHosted!(key))?.remoteShellPid === undefined),
        );
        expect((yield* Effect.promise(() => db.store.getHosted!(key)))?.remoteShellPid).toBe(
          undefined,
        );
        process.emitData(`${remoteShellPidPrefix(session.runtimeGeneration)}900\x07`);
        yield* Effect.promise(() =>
          waitFor(async () => (await db.store.getHosted!(key))?.remoteShellPid === 900),
        );
        // The exit releases the latest copy, not the one the tracker started with.
        process.emitExit({ exitCode: 0, signal: null });
        yield* Effect.promise(() =>
          waitFor(async () => (await db.store.getHosted!(key)) === undefined),
        );
        expect(yield* Effect.promise(() => db.store.getHosted!(key))).toBeUndefined();
      }),
    );

    it.effect("a reattached PTY takes the stored PID; an interrupted one keeps its record", () =>
      Effect.gen(function* () {
        const record = {
          ...hostedDirectShellOwner({
            threadId: "thread-1",
            terminalId: "ssh",
            executionTargetId: SSH_TARGET,
          }),
          remoteShellPid: 55,
        };
        const process = Object.assign(new FakePtyProcess(1), {
          recovered: true,
          interruptionReason: "host-unreachable",
        });
        const session: { runtimeGeneration: string; remoteShellPid?: number | undefined } = {
          runtimeGeneration: "g",
        };
        const releaseHosted = vi.fn(async () => true);
        trackHostedDirectShellRecord({ store: { releaseHosted }, record, process, session });
        expect(session.remoteShellPid).toBe(55);
        process.emitExit({ exitCode: 1, signal: null });
        yield* Effect.promise(flush);
        expect(releaseHosted).not.toHaveBeenCalled();
      }),
    );
  },
);
