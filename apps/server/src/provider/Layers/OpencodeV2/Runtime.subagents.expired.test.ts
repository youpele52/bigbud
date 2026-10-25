import { expect, it, vi } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { startRunning, addChild, taskEvents } from "./Runtime.subagents.fixture.ts";
import { observeV2Subagents } from "./Runtime.subagents.ts";
import { deferred } from "./Test.fixtures.ts";

it.each(["listing", "activity"] as const)(
  "an expired full observer emits no providerSubagent task or hub child registration after delayed %s",
  async (phase) => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const session = await startRunning(runtime, http, directory, `expired-observer-${phase}`);
      const child = addChild(http, session);
      vi.spyOn(runtime, "scheduleRepair").mockImplementation(() => {});
      const publish = vi.spyOn(runtime, "emit");
      const index = vi.spyOn(session.lease.hub, "noteChildren");
      const gate = deferred<void>(),
        entered = deferred<void>();
      const request = http.fetch.bind(http);
      const generation = session.dirtyGeneration;
      vi.spyOn(http, "fetch").mockImplementation(async (url, init) => {
        const pathname = new URL(url).pathname;
        if (pathname === (phase === "listing" ? "/api/session" : "/api/session/active")) {
          entered.resolve();
          await gate.promise;
          return new Response(
            JSON.stringify(
              phase === "listing"
                ? { data: [child], cursor: {} }
                : { data: { ses_child: { type: "running" } } },
            ),
            { headers: { "content-type": "application/json" } },
          );
        }
        return request(url, init);
      });
      const observing = observeV2Subagents(
        runtime,
        session,
        http.messages.get(session.native.id)!,
        () => {
          if (session.dirtyGeneration !== generation) throw new Error("fixture owner expired");
        },
      );
      await entered.promise;
      session.dirtyGeneration++;
      gate.resolve();
      await observing;
      expect(publish).not.toHaveBeenCalled();
      expect(index).not.toHaveBeenCalled();
      expect(taskEvents(events)).toHaveLength(0);
    });
  },
);
