import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { Effect, Option } from "effect";
import { expect } from "vitest";

import type { AppQuitIntentRecord } from "../../lifecycle/AppQuitIntent.ts";
import type { RemoteAgentHostPolicy } from "../../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import type { OwnedPtyHostEvent } from "../Services/OwnedPtyRuntime.ts";
import type { PtyHostWideControl, PtySpawnInput } from "../Services/PTY.ts";
import {
  FakeHostAdapter,
  type FakeHostProcess,
  flush,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { openInput } from "./Manager.test.helpers.ts";

/** One remote host connection: what was pushed, closed and subscribed over it. */
class FakeRemoteConnection {
  readonly policies: RemoteAgentHostPolicy[] = [];
  readonly closeAllCalls: Array<{ reason: string; managedOnly: boolean }> = [];
  listener: ((event: OwnedPtyHostEvent) => void) | undefined;
  closeAllFails = false;
  constructor(readonly key: string) {}
  notice(ptyId: string, kind: string, noticeId: number) {
    this.listener?.({
      type: "notice",
      value: { ptyId, kind, noticeId, closesAtMs: 0, occurredAtMs: 1_700_000_000_000 },
    });
  }
}

/**
 * Remote-agent terminals only: no local host runtime. Each PTY reports the connection that
 * carries it now (`connectionOf`), which a test can move to simulate a reconnect.
 */
class FakeRemoteAdapter extends FakeHostAdapter {
  readonly connections = new Map<string, FakeRemoteConnection>();
  readonly connectionOf = new Map<string, string>();
  nextConnection = "remote-a";
  /** An agent before protocol 1.9: its PTYs have no host-wide controls. */
  oldAgent = false;
  override readonly ownedRuntimeForTarget = () => undefined;

  connection(key: string): FakeRemoteConnection {
    let connection = this.connections.get(key);
    if (!connection) this.connections.set(key, (connection = new FakeRemoteConnection(key)));
    return connection;
  }

  override spawn(input: PtySpawnInput) {
    return super.spawn(input).pipe(
      Effect.tap((process) =>
        Effect.sync(() => {
          if (this.oldAgent) return;
          const host = process as FakeHostProcess;
          this.connectionOf.set(host.remoteResourceId, this.nextConnection);
          const current = () => this.connection(this.connectionOf.get(host.remoteResourceId)!);
          const hostWide: PtyHostWideControl = {
            connectionKey: () => current().key,
            updatePolicy: async (policy) => {
              current().policies.push(policy);
              return policy;
            },
            closeAll: async (closeInput) => {
              const connection = current();
              connection.closeAllCalls.push(closeInput);
              if (connection.closeAllFails) throw new Error("unreachable");
              return 1;
            },
            subscribe: async (listener) => {
              const connection = current();
              connection.listener = listener;
              return () => {
                if (connection.listener === listener) connection.listener = undefined;
              };
            },
          };
          Object.assign(host.lifecycle, { hostWide });
        }),
      ),
    );
  }
}

const intent = (reason: AppQuitIntentRecord["reason"]) =>
  Option.some({ sequence: 1, reason, occurredAt: 1 });

it.layer(NodeServices.layer, { excludeTestServices: true })("remote-agent terminal hosts", (it) => {
  it.effect("pushes the policy once per remote connection, again on reconnect or keep change", () =>
    Effect.gen(function* () {
      const adapter = new FakeRemoteAdapter();
      let keep = false;
      let settingsChanged: (() => void) | undefined;
      const { manager } = yield* makeHostManager(adapter, {
        keepRunningAfterQuit: () => keep,
        onSettingsChange: (listener) => {
          settingsChanged = listener;
          return () => undefined;
        },
      });
      yield* manager.open(openInput({ terminalId: "a1" }));
      yield* manager.open(openInput({ terminalId: "a2" }));
      adapter.nextConnection = "remote-b";
      yield* manager.open(openInput({ terminalId: "b1" }));
      yield* Effect.promise(flush);
      const a = adapter.connection("remote-a");
      const b = adapter.connection("remote-b");
      expect(a.policies.map((policy) => policy.orphanCloseMs)).toEqual([600_000]);
      expect(b.policies).toHaveLength(1);
      expect(a.policies[0]).toMatchObject({ lifecycleEnabled: true, maxLivePtys: 24 });

      // A reconnect moves a PTY to a new connection: that host gets the policy again.
      adapter.connectionOf.set("pty-1", "remote-a2");
      adapter.connectionOf.set("pty-2", "remote-a2");
      yield* manager.open(openInput({ terminalId: "a1" }));
      yield* Effect.promise(flush);
      settingsChanged?.();
      yield* Effect.promise(flush);
      expect(adapter.connection("remote-a2").policies).toHaveLength(1);

      // Keep mode: every connection gets orphan = keep (0), with a newer revision.
      keep = true;
      settingsChanged?.();
      yield* Effect.promise(flush);
      expect(adapter.connection("remote-a2").policies.at(-1)?.orphanCloseMs).toBe(0);
      expect(b.policies.at(-1)?.orphanCloseMs).toBe(0);
      expect(b.policies[1]!.revision).toBeGreaterThan(b.policies[0]!.revision);
      expect(a.policies).toHaveLength(1);
    }),
  );

  it.effect("reports a remote close that follows the exit, for this backend's panes only", () =>
    Effect.gen(function* () {
      const adapter = new FakeRemoteAdapter();
      const { manager } = yield* makeHostManager(adapter);
      const notices: TerminalLifecycleNotice[] = [];
      yield* manager.subscribeLifecycle!((notice) => Effect.sync(() => notices.push(notice)));
      yield* manager.open(openInput());
      yield* Effect.promise(flush);
      (adapter.processes[0] as FakeHostProcess).emitExit({ exitCode: 143, signal: 15 });
      yield* Effect.promise(flush);
      const connection = adapter.connection("remote-a");
      connection.notice("pty-1", "idle_closed", 7);
      // Another client's PTY on the same shared remote host is not ours to report.
      connection.notice("pty-foreign", "idle_closed", 8);
      connection.notice("", "pressure_no_candidate", 9);
      yield* Effect.promise(flush);
      expect(notices.map((notice) => [notice.kind, notice.terminalId])).toEqual([
        ["idleClosed", "default"],
      ]);
      const reopened = yield* manager.open(openInput());
      expect(reopened).toMatchObject({ status: "exited", endedReason: "idle" });
      expect(adapter.spawnInputs).toHaveLength(1);
    }),
  );

  for (const [label, keep, reason, expected] of [
    ["quit with the default setting closes managed terminals", false, "quit", "quit"],
    [
      "an update with the default setting closes them with reason update",
      false,
      "update",
      "update",
    ],
    ["quit in keep mode leaves them running", true, "quit", undefined],
  ] as const)
    it.effect(`remote hosts: ${label}, on every connection`, () =>
      Effect.gen(function* () {
        const adapter = new FakeRemoteAdapter();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { manager } = yield* makeHostManager(adapter, {
              keepRunningAfterQuit: () => keep,
              resolveQuitIntent: Effect.succeed(intent(reason)),
            });
            yield* manager.open(openInput({ terminalId: "a1" }));
            adapter.nextConnection = "remote-b";
            yield* manager.open(openInput({ terminalId: "b1" }));
            yield* manager.open(openInput({ terminalId: "b2" }));
            // An unreachable host is recorded, never waited on past the budget.
            adapter.connection("remote-b").closeAllFails = true;
          }),
        );
        const calls = (key: string) => adapter.connection(key).closeAllCalls;
        const want = expected ? [{ reason: expected, managedOnly: true }] : [];
        expect(calls("remote-a")).toEqual(want);
        expect(calls("remote-b")).toEqual(want);
        // The backend never kills a remote PTY itself; sessions only detach.
        expect(adapter.processes.every((process) => !process.killed)).toBe(true);
      }),
    );

  it.effect("leaves agents before protocol 1.9 exactly as before", () =>
    Effect.gen(function* () {
      const adapter = new FakeRemoteAdapter();
      adapter.oldAgent = true;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { manager } = yield* makeHostManager(adapter, {
            keepRunningAfterQuit: () => false,
            resolveQuitIntent: Effect.succeed(intent("quit")),
          });
          yield* manager.open(openInput());
          yield* Effect.promise(flush);
        }),
      );
      expect(adapter.connections.size).toBe(0);
      expect(adapter.processes[0]?.killed).toBe(false);
    }),
  );
});
