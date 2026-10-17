import { Effect } from "effect";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi, type Mock } from "vitest";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { makeV2SharedTargetPreparation } from "./Application.targets.shared.ts";

it.each([false, true])(
  "post-acquisition canonical activation failure releases the exact borrowed lease across initial/retry attempts (cleanup throws=%s)",
  async (cleanupThrows) => {
    await withV2RuntimeFixture(async ({ runtime: baseline, http, directory }) => {
      const options = { ...sharedV2FixtureOptions(baseline, http), enableLocalTools: true };
      const acquired: Array<Mock<() => Promise<void>>> = [];
      const signals: AbortSignal[] = [];
      const acquire = options.manager.acquire.bind(options.manager);
      const acquireSpy = vi.spyOn(options.manager, "acquire").mockImplementation(async (config) => {
        const lease = await acquire(config);
        const release = vi.fn(lease.release);
        acquired.push(release);
        return { ...lease, release };
      });
      const subscribe = http.client.event.subscribe.bind(http.client.event);
      const subscriptionSpy = vi
        .spyOn(http.client.event, "subscribe")
        .mockImplementation((input) => {
          if (input?.signal) signals.push(input.signal);
          return subscribe(input);
        });
      const cleanup = vi.fn(async () => {
        if (cleanupThrows) throw new Error("Synthetic prepared cleanup failure");
      });
      const activate = vi.fn(async () => {
        throw new Error("Synthetic canonical auth activation failure");
      });
      const prepare = makeV2SharedTargetPreparation(options, directory, 0);
      const runtime = new OpencodeV2Runtime({
        ...options,
        prepareSession: async (...args) => {
          const prepared = await prepare(...args);
          return {
            ...prepared,
            resources: { ...prepared.resources, cleanup, activateCanonicalTools: activate },
          };
        },
      });
      const input = {
        threadId: ThreadId.makeUnsafe("activation-failure"),
        cwd: directory,
        runtimeMode: "approval-required" as const,
        modelSelection: {
          provider: "opencodeV2" as const,
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      };
      let binding: unknown;
      let native: string | undefined;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(runtime.start(input)).rejects.toThrow("Synthetic");
          expect(runtime.sessions.size).toBe(0);
          expect(activate).toHaveBeenCalledTimes(attempt + 1);
          expect(cleanup).toHaveBeenCalledTimes(attempt + 1);
          expect(acquired).toHaveLength(attempt + 1);
          for (const release of acquired) expect.soft(release).toHaveBeenCalledTimes(1);
          const entries = (
            options.manager as unknown as { entries: Map<string, { references: number }> }
          ).entries;
          expect
            .soft([...entries.values()].reduce((sum, entry) => sum + entry.references, 0))
            .toBe(0);
          expect.soft(signals.length).toBeGreaterThan(0);
          expect.soft(signals.every((signal) => signal.aborted)).toBe(true);
          const current = await Effect.runPromise(options.sharedBindings!.find(input.threadId));
          const bytes = JSON.stringify([...http.sessions.values()]);
          if (!attempt) {
            binding = current;
            native = bytes;
          } else {
            expect(current).toEqual(binding);
            expect(bytes).toBe(native);
          }
          expect(current?.state).toBe("verified");
          expect(
            await Effect.runPromise(options.journal.latestBound(input.threadId)),
          ).toBeUndefined();
          expect(
            http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
          ).toHaveLength(1);
          expect(
            http.calls.some(
              (call) => call.pathname.endsWith("/prompt") || call.method === "DELETE",
            ),
          ).toBe(false);
        }
      } finally {
        await runtime.close();
        acquireSpy.mockRestore();
        subscriptionSpy.mockRestore();
      }
    });
  },
);
