import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { TerminalEvent } from "@bigbud/contracts";
import { TerminalLimitError } from "@bigbud/contracts/workspace/terminal.limit.ts";
import { Effect } from "effect";
import { describe, expect, it as vitest } from "vitest";

import { RemoteAgentPtyLimitError } from "../../remote-agent/remoteAgentPtyClient.types.ts";
import { profileOwner } from "../../remote-agent/remoteAgentOwnedPty.profile.testUtils.ts";
import { PtySpawnError } from "../Services/PTY.ts";
import {
  FakeHostAdapter,
  type FakeHostProcess,
  flush,
  makeHostManager,
} from "./Manager.host.test.helpers.ts";
import { findTerminalHostLimitError, toTerminalLimitError } from "./Manager.hostLimit.ts";
import { openInput } from "./Manager.test.helpers.ts";

describe("host limit errors", () => {
  vitest("finds the refusal through nested spawn-error causes", () => {
    const refusal = new RemoteAgentPtyLimitError("limit", { limit: 24, liveCount: 24 });
    const nested = new PtySpawnError({
      adapter: "terminal-manager",
      message: "Failed",
      cause: new PtySpawnError({
        adapter: "local-terminal-host",
        message: "limit",
        cause: refusal,
      }),
    });
    expect(findTerminalHostLimitError(nested)).toBe(refusal);
    expect(findTerminalHostLimitError(new Error("ENOENT"))).toBeUndefined();
  });

  vitest("names the roster's least recently used pane, or no candidate", async () => {
    const context = {
      sessions: () => Effect.succeed([]),
      roster: () => [
        {
          threadId: "t-old",
          terminalId: "old",
          ptyId: "pty-9",
          lost: false,
          activityState: "busy",
          lastUsedMs: Date.parse("2026-11-21T09:00:00.000Z"),
        },
      ],
      runtime: undefined,
    };
    const named = await Effect.runPromise(
      toTerminalLimitError(
        context,
        new RemoteAgentPtyLimitError("limit", {
          limit: 24,
          liveCount: 24,
          evictionCandidatePtyId: "pty-9",
        }),
      ),
    );
    expect(named).toBeInstanceOf(TerminalLimitError);
    expect(named.candidate).toEqual({
      threadId: "t-old",
      terminalId: "old",
      lastUsedAt: "2026-11-21T09:00:00.000Z",
      busy: true,
    });
    const unnamed = await Effect.runPromise(
      toTerminalLimitError(context, new RemoteAgentPtyLimitError("limit", {})),
    );
    expect(unnamed).toMatchObject({ limit: 24, liveCount: 24, candidate: null });
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("host live limit", (it) => {
  it.effect("fails the open with TerminalLimitError and leaves no errored pane", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const { manager } = yield* makeHostManager(adapter);
      const events: TerminalEvent[] = [];
      yield* manager.subscribe((event) => Effect.sync(() => events.push(event)));
      yield* manager.open(openInput());
      (adapter.processes[0] as FakeHostProcess).emitActivity(true);

      adapter.refuseNext = { candidate: "pty-1", limit: 24, liveCount: 24 };
      const failure = yield* manager.open(openInput({ terminalId: "second" })).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(TerminalLimitError);
      expect(failure).toMatchObject({
        limit: 24,
        liveCount: 24,
        candidate: { threadId: "thread-1", terminalId: "default", busy: true },
      });
      const lookup = yield* manager
        .snapshot({ threadId: "thread-1", terminalId: "second" })
        .pipe(Effect.flip);
      expect(lookup._tag).toBe("TerminalSessionLookupError");
      expect(events.some((event) => event.type === "error")).toBe(false);
    }),
  );

  it.effect("passes the confirmed candidate's pty_id so the host closes it first", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const { manager } = yield* makeHostManager(adapter);
      yield* manager.open(openInput());
      yield* manager.open(
        openInput({ terminalId: "second", evict: { threadId: "thread-1", terminalId: "default" } }),
      );
      expect(adapter.spawnInputs.at(-1)?.hostLifecycle).toEqual({ evictPtyId: "pty-1" });
      // The host's limit_closed notice ends the evicted pane with its reason.
      const evicted = adapter.processes[0] as FakeHostProcess;
      evicted.emitNotice("limit_closed");
      evicted.emitExit({ exitCode: 0, signal: null });
      yield* Effect.promise(flush);
      const snapshot = yield* manager.snapshot({ threadId: "thread-1", terminalId: "default" });
      expect(snapshot.endedReason).toBe("limit");
    }),
  );

  it.effect("evicts a pane known only from its durable owner after a restart", () =>
    Effect.gen(function* () {
      const adapter = new FakeHostAdapter();
      const ownerKey = `terminal:${JSON.stringify(["t-old", "old"])}`;
      adapter.ownership.rows.set(ownerKey, {
        ...profileOwner(),
        ownerKey,
        target: "local-terminal-host",
        resourceId: "pty-old",
        state: "may-have-been-sent",
      });
      const { manager } = yield* makeHostManager(adapter);
      yield* manager.open(openInput({ evict: { threadId: "t-old", terminalId: "old" } }));
      expect(adapter.spawnInputs.at(-1)?.hostLifecycle).toEqual({ evictPtyId: "pty-old" });
    }),
  );
});
