import { expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { withV2DeliveryFixture } from "./Runtime.delivery.fixture.ts";
import { validV2Publication } from "./Runtime.publication.ts";

it("healthy actual hub completion preserves buffered tool/assistant output and one terminal after its callback returns", async () => {
  const queued: ProviderRuntimeEvent[] = [];
  await withV2DeliveryFixture(
    (event) => queued.push(event),
    async ({ owner, callback, dirtyReasons, deliver, runtime }) => {
      const dirty = owner.dirtyGeneration,
        hub = owner.lease.hub.generation(owner.native.id);
      deliver();
      const result = await callback;
      await new Promise((resolve) => setImmediate(resolve));
      const received = queued.filter(validV2Publication);
      expect(
        received.filter((event) => event.type === "item.completed").map((event) => event.payload),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemType: "dynamic_tool_call",
            detail: "healthy final tool output",
          }),
          expect.objectContaining({
            itemType: "assistant_message",
            detail: "healthy final assistant output",
          }),
        ]),
      );
      expect(received.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(result).toBeUndefined();
      expect(dirtyReasons).toEqual([]);
      expect(owner.dirtyGeneration).toBe(dirty);
      expect(owner.lease.hub.generation(owner.native.id)).toBe(hub);
      expect(owner.lease.hub.isDirty(owner.native.id)).toBe(false);
      await runtime.reconcile(owner);
      expect(
        queued.filter(validV2Publication).filter((event) => event.type === "turn.completed"),
      ).toHaveLength(1);
    },
  );
});
