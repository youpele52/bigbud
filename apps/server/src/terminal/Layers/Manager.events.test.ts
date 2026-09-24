import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, type TerminalEvent } from "@bigbud/contracts";
import { Effect, Ref, Scope } from "effect";
import { expect } from "vitest";

import {
  createManager,
  FakePtyAdapter,
  historyLogPath,
  openInput,
  readFileString,
  restartInput,
  waitFor,
} from "./Manager.test.helpers";

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager", (it) => {
  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let hasRunningSubprocess = false;
      const { manager, getEvents } = yield* createManager(5, {
        subprocessChecker: () => Effect.succeed(hasRunningSubprocess),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      hasRunningSubprocess = true;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
        ),
        "1200 millis",
      );

      hasRunningSubprocess = false;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessChecker: () => {
          checks += 1;
          return Effect.succeed(false);
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("replaces the agent identity when the harness changes and clears it at the shell", () =>
    Effect.gen(function* () {
      let detectedAgent: "pi" | "opencode" | null = null;
      const { manager, getEvents } = yield* createManager(5, {
        agentDetector: (pids) => Effect.succeed(new Map(pids.map((pid) => [pid, detectedAgent]))),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      detectedAgent = "pi";
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "agentIdentity" && event.provider === "pi"),
        ),
        "1200 millis",
      );

      detectedAgent = "opencode";
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "agentIdentity" && event.provider === "opencode"),
        ),
        "1200 millis",
      );

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
      ).toEqual(["pi", "opencode", null]);
      expect(
        new Set(
          (yield* getEvents)
            .filter((event) => event.type === "agentIdentity")
            .map((event) => event.runtimeGeneration),
        ).size,
      ).toBe(1);
    }),
  );

  it.effect("replays current identity when a terminal event subscriber reconnects", () =>
    Effect.gen(function* () {
      let detectedAgent: "pi" | "opencode" | null = "pi";
      const { manager, getEvents } = yield* createManager(5, {
        agentDetector: (pids) => Effect.succeed(new Map(pids.map((pid) => [pid, detectedAgent]))),
        subprocessPollIntervalMs: 20,
      });
      const opened = yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "agentIdentity" && event.provider === "pi"),
        ),
        "1200 millis",
      );

      const firstSubscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(firstSubscriberEvents, (events) => [...events, event]),
      );
      expect((yield* Ref.get(firstSubscriberEvents)).at(-1)).toMatchObject({
        type: "agentIdentity",
        provider: "pi",
        terminalId: opened.terminalId,
      });
      unsubscribe();

      detectedAgent = "opencode";
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "agentIdentity" && event.provider === "opencode"),
        ),
        "1200 millis",
      );
      const secondSubscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribeAgain = yield* manager.subscribe((event) =>
        Ref.update(secondSubscriberEvents, (events) => [...events, event]),
      );
      expect((yield* Ref.get(secondSubscriberEvents)).at(-1)).toMatchObject({
        type: "agentIdentity",
        provider: "opencode",
        terminalId: opened.terminalId,
      });
      unsubscribeAgain();
    }),
  );

  it.effect("delivers a live identity change after the subscription replay", () =>
    Effect.gen(function* () {
      let detectedAgent: "pi" | "opencode" = "pi";
      const { manager, getEvents } = yield* createManager(5, {
        agentDetector: (pids) => Effect.succeed(new Map(pids.map((pid) => [pid, detectedAgent]))),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "agentIdentity" && event.provider === "pi"),
        ),
        "1200 millis",
      );

      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      let handlingReplay = true;
      const unsubscribe = yield* manager.subscribe((event) =>
        Effect.gen(function* () {
          yield* Ref.update(subscriberEvents, (events) => [...events, event]);
          if (event.type !== "agentIdentity" || !handlingReplay) return;
          handlingReplay = false;
          detectedAgent = "opencode";
          yield* waitFor(
            Effect.map(getEvents, (events) =>
              events.some(
                (entry) => entry.type === "agentIdentity" && entry.provider === "opencode",
              ),
            ),
            "1200 millis",
          ).pipe(Effect.orDie);
        }),
      );
      expect(
        (yield* Ref.get(subscriberEvents)).map(
          (event) => event.type === "agentIdentity" && event.provider,
        ),
      ).toEqual(["pi", "opencode"]);
      unsubscribe();
    }),
  );

  it.effect("replays a cleared identity if the terminal exits while disconnected", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        agentDetector: (pids) => Effect.succeed(new Map(pids.map((pid) => [pid, "pi" as const]))),
        subprocessPollIntervalMs: 20,
      });
      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "agentIdentity" && event.provider === "pi"),
        ),
        "1200 millis",
      );
      ptyAdapter.processes[0]?.emitData("output after identity\n");
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data.includes("after identity")),
        ),
        "1200 millis",
      );
      ptyAdapter.processes[0]?.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );
      const events = yield* getEvents;
      const identityAt = events.find(
        (event) => event.type === "agentIdentity" && event.provider === "pi",
      )?.createdAt;
      const outputAt = events.find(
        (event) => event.type === "output" && event.data.includes("after identity"),
      )?.createdAt;
      const exitAt = events.find((event) => event.type === "exited")?.createdAt;
      expect(identityAt && outputAt && exitAt && identityAt < outputAt && outputAt < exitAt).toBe(
        true,
      );

      const replayed = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(replayed, (events) => [...events, event]),
      );
      expect((yield* Ref.get(replayed)).at(-1)).toMatchObject({
        type: "agentIdentity",
        provider: null,
      });
      unsubscribe();
    }),
  );

  it.effect("resets identity on restart and does not carry it into the new process", () =>
    Effect.gen(function* () {
      let detectedAgent: "pi" | null = "pi";
      const { manager, getEvents } = yield* createManager(5, {
        agentDetector: (pids) => Effect.succeed(new Map(pids.map((pid) => [pid, detectedAgent]))),
        subprocessPollIntervalMs: 20,
      });
      const opened = yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "agentIdentity" && event.provider === "pi"),
        ),
        "1200 millis",
      );

      detectedAgent = null;
      const restarted = yield* manager.restart(restartInput());
      expect(restarted.activeAgentProvider).toBeNull();
      expect(restarted.runtimeGeneration).not.toBe(opened.runtimeGeneration);
      expect((yield* getEvents).findLast((event) => event.type === "restarted")).toMatchObject({
        type: "restarted",
        snapshot: { activeAgentProvider: null },
      });
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const scope = yield* Effect.scope;
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("batches queued PTY output while preserving exit ordering", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 2;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\nsecond\n" }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0 }),
      ]);
    }),
  );

  it.effect("flushes queued PTY output before clearing the transcript", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, logsDir } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("stale-before-clear\n");
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* Effect.sleep("80 millis");

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "cleared",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "stale-before-clear\n" }),
        expect.objectContaining({ type: "cleared" }),
      ]);
      expect(yield* readFileString(historyLogPath(logsDir))).toBe("");
    }),
  );
});
