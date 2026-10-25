import { expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { withV2DeliveryFixture } from "./Runtime.delivery.fixture.ts";
import { validV2Publication } from "./Runtime.publication.ts";
import { deferred } from "./Test.fixtures.ts";

it("ordinary polls queue behind a healthy draining read without invalidating its publication generation", async () => {
  const queued: ProviderRuntimeEvent[] = [];
  await withV2DeliveryFixture(
    (event) => queued.push(event),
    async ({ owner, http, deliver, callback, dirtyReasons }) => {
      const entered = deferred<void>(),
        release = deferred<void>();
      const original = http.client.message.list.bind(http.client.message);
      const read = vi.spyOn(http.client.message, "list").mockImplementation(async (...args) => {
        const value = await original(...args);
        entered.resolve();
        await release.promise;
        return value;
      });
      const dirty = owner.dirtyGeneration;
      try {
        deliver();
        await entered.promise;
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(owner.dirtyGeneration).toBe(dirty);
        release.resolve();
        expect(await callback).toBeUndefined();
        await new Promise((resolve) => setImmediate(resolve));
        expect(dirtyReasons).toEqual([]);
        expect(
          queued.filter(validV2Publication).filter((event) => event.type === "turn.completed"),
        ).toHaveLength(1);
      } finally {
        release.resolve();
        read.mockRestore();
      }
    },
    { pollIntervalMs: 100 },
  );
});
