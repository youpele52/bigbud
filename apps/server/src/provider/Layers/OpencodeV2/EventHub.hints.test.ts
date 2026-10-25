import { Effect } from "effect";
import { expect, it } from "vitest";
import { OpencodeV2EventHub } from "./EventHub.ts";
import {
  officialV2EventFixture,
  officialSseFrame,
  officialSseMarker,
} from "./EventHub.official.fixture.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { runAuthorizedV2 } from "./Client.guard.ts";

it("official Location-optional execution-start hint is ignored, while wrong Location and malformed durable identity still dirty the owner", async () => {
  for (const corruption of ["wrong-location", "wrong-aggregate"] as const) {
    const fixture = await officialV2EventFixture();
    const settings = await Effect.runPromise(
      makeTestSettings({
        providers: { opencodeV2: { enabled: true, nativeServiceTrust: "host-user-v1" } },
      }),
    );
    const consent = new V2ConsentAuthority(settings);
    let events = 0,
      dirty = 0,
      activity = 0;
    const hub = new OpencodeV2EventHub({
      maxOwners: 1,
      maxQueuedEvents: 8,
      maxEventBytes: 10000,
      consumerTimeoutMs: 1000,
      requireMarker: true,
      subscribe: (signal, touch) =>
        fixture.client.event.subscribe({
          signal,
          onActivity: () => {
            activity++;
            touch?.();
          },
        }),
    });
    hub.register({
      nativeSessionId: "ses_owned",
      location: "/synthetic/workspace",
      onDirty: () => {
        dirty++;
      },
      onEvent: async () => {
        events++;
      },
    });
    const start = {
      id: "evt_native_started",
      created: 1,
      type: "session.execution.started",
      data: { sessionID: "ses_owned" },
      durable: { version: 1, seq: 1, aggregateID: "ses_owned" },
    };
    try {
      await runAuthorizedV2(consent, fixture.transport, async () => hub.start());
      const response = await fixture.connected;
      response.write(officialSseMarker);
      await expect.poll(() => activity).toBeGreaterThan(0);
      const before = activity;
      response.write(officialSseFrame(start));
      await expect.poll(() => activity).toBeGreaterThan(before);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(events).toBe(0);
      expect(dirty).toBe(0);
      expect(hub.isDirty("ses_owned")).toBe(false);
      response.write(
        officialSseFrame(
          corruption === "wrong-location"
            ? { ...start, location: { directory: "/other/workspace" } }
            : { ...start, durable: { ...start.durable, aggregateID: "ses_other" } },
        ),
      );
      await expect.poll(() => dirty).toBeGreaterThan(0);
      expect(events).toBe(0);
      expect(hub.isDirty("ses_owned")).toBe(true);
    } finally {
      await hub.close();
      consent.close();
      await fixture.close();
    }
  }
});
