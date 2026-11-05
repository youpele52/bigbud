import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import { describe, expect, it } from "vitest";
import { makeTerminalIdleGuard } from "./orchestration/Layers/OrchestrationEngine.terminalIdle.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import { ServerSettingsService } from "./ws/serverSettings.ts";
import { withEngineTerminal } from "./server.engineTerminal.ts";

const command = {
  type: "thread.organization.idle" as const,
  commandId: CommandId.makeUnsafe("legacy-terminal-guard"),
  threadId: ThreadId.makeUnsafe("guard-thread"),
  expectedRevision: 0,
  fromState: "present" as const,
  destination: "done" as const,
  createdAt: new Date(2 * 86_400_000).toISOString(),
};
const terminalStub = (
  get: NonNullable<TerminalManagerShape["getThreadIdleWork"]>,
): TerminalManagerShape => ({
  getThreadIdleWork: get,
  open: () => Effect.die("unused"),
  snapshot: () => Effect.die("unused"),
  restart: () => Effect.die("unused"),
  write: () => Effect.void,
  resize: () => Effect.void,
  clear: () => Effect.void,
  close: () => Effect.void,
  subscribe: () => Effect.succeed(() => {}),
});
class Guard extends ServiceMap.Service<
  Guard,
  Effect.Success<ReturnType<typeof makeTerminalIdleGuard>>
>()("test/engineGuard") {}

describe("production engine terminal composition", () => {
  for (const order of ["cleanup-first", "normal-first"] as const) {
    it(`${order}: both consumers capture the same terminal, even without ambient terminal context`, async () => {
      let builds = 0;
      const terminal = terminalStub(() => Effect.succeed({ state: "busy", quietSince: null }));
      const terminalLayer = Layer.effect(
        TerminalManager,
        Effect.sync(() => {
          builds++;
          return terminal;
        }),
      );
      const engine = withEngineTerminal(
        Layer.effect(Guard, makeTerminalIdleGuard()),
        terminalLayer,
      );
      const seen: TerminalManagerShape[] = [];
      const consumer = () =>
        Layer.effectDiscard(
          Effect.gen(function* () {
            const guard = yield* Guard;
            expect(yield* guard(command)).toBe(true);
            seen.push(yield* TerminalManager);
          }),
        ).pipe(Layer.provide(engine), Layer.provide(terminalLayer));
      const cleanup = consumer();
      const normal = consumer();
      const consumers =
        order === "cleanup-first"
          ? Layer.mergeAll(cleanup, normal)
          : Layer.mergeAll(normal, cleanup);
      await Effect.runPromise(
        Effect.scoped(
          Layer.build(consumers.pipe(Layer.provide(ServerSettingsService.layerTest()))),
        ),
      );
      expect(builds).toBe(1);
      expect(seen).toEqual([terminal, terminal]);
    });
  }

  it("legacy cutoff ignores a disabled longer rule with the same destination", async () => {
    const manager = terminalStub(() =>
      Effect.succeed({
        state: "idle",
        quietSince: Date.parse(command.createdAt) - 20 * 60_000,
      }),
    );
    const blocked = await Effect.runPromise(
      Effect.gen(function* () {
        const guard = yield* makeTerminalIdleGuard();
        return yield* guard(command);
      }).pipe(
        Effect.provideService(TerminalManager, manager),
        Effect.provide(
          ServerSettingsService.layerTest({
            inyosiraIdleCleanupEnabled: true,
            inyosiraIdleTimeoutMinutes: 10,
            inyosiraIdleDestination: "done",
            inyosiraOlderThreadsEnabled: false,
            inyosiraOlderThreadsDays: 1,
          }),
        ),
      ),
    );
    expect(blocked).toBe(false);
  });
});
