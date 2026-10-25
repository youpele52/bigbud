import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { capHistory } from "./Manager.history";
import {
  createManager,
  historyLogPath,
  openInput,
  pathExists,
  readFileString,
  writeFileString,
  waitFor,
} from "./Manager.test.helpers";

it("does not retain history when the configured line limit is non-positive", () => {
  expect(capHistory("one\ntwo\n", 0)).toBe("\n");
  expect(capHistory("one", -1)).toBe("");
});

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager", (it) => {
  it.effect("starts fresh from existing disk logs but preserves warm history and PID", () =>
    Effect.gen(function* () {
      const { manager, logsDir, ptyAdapter } = yield* createManager();
      const log = historyLogPath(logsDir);
      yield* writeFileString(log, "old OpenCode\n".repeat(100_000));
      const opened = yield* manager.open(openInput());
      expect(opened.history).toBe("");
      expect(yield* readFileString(log)).toBe("old OpenCode\n".repeat(100_000));
      // The ownership fence is independent of whether screen history is loaded.
      expect(ptyAdapter.spawnInputs[0]?.recoverOnly).toBe(true);
      ptyAdapter.processes[0]!.emitData("current Pi\n");
      yield* waitFor(
        manager.snapshot(openInput()).pipe(Effect.map((s) => s.history === "current Pi\n")),
      );
      const warm = yield* manager.open(openInput());
      expect(warm.pid).toBe(opened.pid);
      expect(warm.history).toBe("current Pi\n");
      expect(ptyAdapter.processes).toHaveLength(1);
      yield* manager.close({ threadId: "thread-1" });
      const fresh = yield* manager.open(openInput());
      expect(fresh.pid).not.toBe(opened.pid);
      expect(fresh.history).toBe("");
      expect(fresh.historyTruncated).toBeUndefined();
    }),
  );

  it.effect(
    "refuses incomplete replay after the line limit without restarting the live process",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(3);
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("line1\nline2\nline3\nline4\n");
        yield* waitFor(
          manager.snapshot(openInput()).pipe(Effect.map((s) => s.historyTruncated === true)),
        );
        const reopened = yield* manager.open(openInput());
        expect(reopened.history).toBe("");
        expect(reopened.historyTruncated).toBe(true);
        expect(reopened.pid).toBe(process.pid);
        expect(ptyAdapter.processes).toHaveLength(1);
        expect(process.killed).toBe(false);
      }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* waitFor(
        manager.snapshot(openInput()).pipe(Effect.map((s) => s.history.endsWith("done\n"))),
      );

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* waitFor(
          manager.snapshot(openInput()).pipe(Effect.map((s) => s.history.endsWith("\n"))),
        );

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* waitFor(
        manager.snapshot(openInput()).pipe(Effect.map((s) => s.history.endsWith("after\n"))),
      );

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* waitFor(
          manager.snapshot(openInput()).pipe(Effect.map((s) => s.history.endsWith("after\n"))),
        );

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("ignores legacy transcripts without migrating or deleting them on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "");
      expect(yield* pathExists(nextPath)).toBe(false);
      expect(yield* readFileString(legacyPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(true);
    }),
  );
});
