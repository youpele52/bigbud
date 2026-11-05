import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { beforeEach, afterEach, expect, vi } from "vitest";
import { createManager, openInput } from "./Manager.test.helpers";

beforeEach(() => vi.stubEnv("BIGBUD_TERMINAL_RECOVERY", "1"));
afterEach(() => vi.unstubAllEnvs());

it.layer(NodeServices.layer, { excludeTestServices: true })("recovery producer pressure", (it) => {
  it.effect("releases a detached producer at low water without a renderer acknowledgement", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const input = openInput();
      const opened = yield* manager.open(input);
      const proc = ptyAdapter.processes[0]!;
      proc.emitData("x".repeat(350_000) + "\r");
      expect(proc.paused).toBe(true);
      const snapshot = yield* manager.recovery!({
        ...input,
        terminalId: input.terminalId!,
        expectedGeneration: opened.runtimeGeneration!,
      });
      expect(snapshot.type).toBe("snapshot");
      expect(proc.paused).toBe(false);
      expect((yield* manager.snapshot(input)).pid).toBe(opened.pid);
    }),
  );

  it.effect("composes recovery and delivery holds instead of releasing another consumer", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const input = openInput();
      const opened = yield* manager.open(input);
      const proc = ptyAdapter.processes[0]!;
      const hold = (held: boolean) =>
        manager.setOutputHold!({ ...input, terminalId: input.terminalId!, holderId: "view", held });
      yield* hold(true);
      proc.emitData("x".repeat(350_000));
      yield* manager.recovery!({
        ...input,
        terminalId: input.terminalId!,
        expectedGeneration: opened.runtimeGeneration!,
      });
      expect(proc.paused).toBe(true);
      yield* hold(false);
      expect(proc.paused).toBe(false);
      proc.emitData("x".repeat(350_000));
      yield* hold(false);
      expect(proc.paused).toBe(true);
      yield* manager.recovery!({
        ...input,
        terminalId: input.terminalId!,
        expectedGeneration: opened.runtimeGeneration!,
      });
      expect(proc.paused).toBe(false);
    }),
  );

  it.effect(
    "releases model pressure on close and never carries it into a replacement generation",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const input = openInput();
        yield* manager.open(input);
        const old = ptyAdapter.processes[0]!;
        old.emitData("x".repeat(350_000));
        expect(old.paused).toBe(true);
        yield* manager.restart({ ...input, cols: 80, rows: 24 });
        expect(old.paused).toBe(false);
        expect(ptyAdapter.processes[1]!.paused).toBe(false);
        yield* manager.close(input);
      }),
  );
});
