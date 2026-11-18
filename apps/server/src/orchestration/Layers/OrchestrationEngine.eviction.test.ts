import { CommandId, ProjectId, ThreadId, type OrchestrationCommand } from "@bigbud/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import {
  ensureOrchestrationProjectThreads,
  ensureOrchestrationThreadSubtree,
  getOrchestrationThread,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const projectId = ProjectId.makeUnsafe("eviction-project");
const createdAt = "2026-11-18T00:00:00.000Z";
const ids = (count: number, prefix = "evict") =>
  Array.from({ length: count }, (_, index) => ThreadId.makeUnsafe(`${prefix}-${index}`));
const bounds = { maxResidentThreads: 10, idleTtlMs: 60_000, minResidencyMs: 1_000, batch: 200 };

/** A real engine over SQLite whose residency clock the test drives. */
async function start(dbPath: string, seed: ReadonlyArray<ThreadId>) {
  const clock = { now: 0 };
  const runtime = createRuntime(dbPath, undefined, undefined, {
    bounds,
    nowMs: () => clock.now,
  });
  const engine = await engineFor(runtime);
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  for (const command of seed.length > 0 ? createCommands(projectId, seed) : []) {
    await run(engine.dispatch(command));
  }
  const evict = (held: ReadonlySet<string> = new Set()) =>
    run(engine.evictIdleThreads!({ isHeld: (threadId) => Effect.succeed(held.has(threadId)) }));
  const resident = async () =>
    new Set((await run(engine.getReadModel())).threads.map((thread) => thread.id as string));
  return { clock, runtime, engine, run, evict, resident };
}

const dispatch = (engine: OrchestrationEngineShape, command: OrchestrationCommand) =>
  engine.dispatch(command);

describe("OrchestrationEngine read-model eviction (F-B4)", () => {
  it("keeps the read model bounded under many threads and rehydrates every access path", () =>
    withDatabase("bigbud-evict-bound-", async (dbPath) => {
      const threadIds = ids(50);
      const { clock, run, engine, evict, resident, runtime } = await start(dbPath, threadIds);
      expect((await resident()).size).toBe(50);

      clock.now = 500; // under the minimum residency: nothing goes
      expect((await evict()).evicted).toBe(0);
      clock.now = 2_000;
      expect(await evict()).toEqual({ evicted: 40, resident: 10 });
      expect((await resident()).size).toBe(10);
      const residentNow = await resident();
      const gone = threadIds.filter((id) => !residentNow.has(id));
      expect(gone).toHaveLength(40);

      // Accessor: an evicted thread comes back intact.
      const back = await run(getOrchestrationThread(engine, gone[0]!));
      expect(back?.title).toBe(`Thread ${gone[0]}`);
      expect((await resident()).has(gone[0]!)).toBe(true);

      // Command path: prepareCommandState hydrates the target before the decider.
      await run(
        dispatch(engine, {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("evicted-rename"),
          threadId: gone[1]!,
          title: "Renamed after eviction",
        }),
      );
      expect((await run(getOrchestrationThread(engine, gone[1]!)))?.title).toBe(
        "Renamed after eviction",
      );

      // Project-wide reads see every live thread again, then a sweep bounds them again.
      const all = await run(ensureOrchestrationProjectThreads(engine, projectId));
      expect(all.map((thread) => thread.id).toSorted()).toEqual([...threadIds].toSorted());
      clock.now = 4_000;
      await evict();
      expect((await resident()).size).toBe(10);
      await runtime.dispose();
    }));

  it("hydrates an evicted descendant for subtree deletion and keeps ancestor chains whole", () =>
    withDatabase("bigbud-evict-subtree-", async (dbPath) => {
      const root = ThreadId.makeUnsafe("evict-root");
      const child = ThreadId.makeUnsafe("evict-child");
      const { clock, run, engine, evict, resident, runtime } = await start(dbPath, [root]);
      await run(
        dispatch(engine, {
          ...createCommands(projectId, [child])[1]!,
          commandId: CommandId.makeUnsafe("create-child"),
          parentThread: { threadId: root, projectId, title: "Root" },
        } as OrchestrationCommand),
      );
      clock.now = 120_000;
      // The root is a parent of a resident thread: only the leaf goes in this sweep.
      expect((await evict()).evicted).toBe(1);
      expect([...(await resident())]).toEqual([root]);
      const subtree = await run(ensureOrchestrationThreadSubtree(engine, root));
      expect(subtree.map((thread) => thread.id).toSorted()).toEqual([child, root].toSorted());
      await runtime.dispose();
    }));

  it("never evicts a thread with live work, an outside hold, or an operational SQL row", () =>
    withDatabase("bigbud-evict-live-", async (dbPath) => {
      const [ready, held, pinned, leased, idle] = ids(5, "live");
      const { clock, run, engine, evict, resident, runtime } = await start(dbPath, [
        ready!,
        held!,
        pinned!,
        leased!,
        idle!,
      ]);
      await run(
        dispatch(engine, {
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("ready-session"),
          threadId: ready!,
          session: {
            threadId: ready!,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      await run(
        dispatch(engine, {
          type: "thread.pin",
          commandId: CommandId.makeUnsafe("pin"),
          threadId: pinned!,
          createdAt,
        } as OrchestrationCommand),
      );
      // In memory the leased thread is idle; only the per-thread SQL check can keep it.
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
            VALUES ('lease-1', ${leased!}, 'browser', ${createdAt})`;
        }),
      );
      clock.now = 600_000;
      expect((await evict(new Set([held!]))).evicted).toBe(1);
      expect([...(await resident())].toSorted()).toEqual([held, leased, pinned, ready].toSorted());
      await runtime.dispose();
    }));

  it("survives a restart and a mixed workload of commands, reads and sweeps", () =>
    withDatabase("bigbud-evict-mixed-", async (dbPath) => {
      const threadIds = ids(30, "mixed");
      const first = await start(dbPath, threadIds);
      await first.runtime.dispose();

      const second = await start(dbPath, []);
      // The startup window holds only operational threads: none of these settled ones.
      expect((await second.resident()).size).toBe(0);
      const work = threadIds.map((threadId, index) =>
        Effect.gen(function* () {
          yield* dispatch(second.engine, {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`mixed-rename-${index}`),
            threadId,
            title: `Mixed ${index}`,
          });
          second.clock.now += 700;
          if (index % 3 === 0)
            yield* second.engine.evictIdleThreads!({ isHeld: () => Effect.succeed(false) });
          return yield* getOrchestrationThread(second.engine, threadId);
        }),
      );
      const results = await second.run(Effect.all(work, { concurrency: 6 }));
      expect(results.map((thread) => thread?.title)).toEqual(threadIds.map((_, i) => `Mixed ${i}`));
      second.clock.now += 120_000;
      await second.evict();
      expect((await second.resident()).size).toBeLessThanOrEqual(bounds.maxResidentThreads);
      const all = await second.run(ensureOrchestrationProjectThreads(second.engine, projectId));
      expect(all.map((thread) => thread.title).toSorted()).toEqual(
        threadIds.map((_, i) => `Mixed ${i}`).toSorted(),
      );
      await second.runtime.dispose();
    }));
});
