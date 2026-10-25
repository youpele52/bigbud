import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { runAuthorizedV2 } from "./Client.guard.ts";
import { OpencodeV2EventHub } from "./EventHub.ts";
import { deferred } from "./Test.fixtures.ts";
import {
  officialV2EventFixture,
  officialSseFrame,
  officialSseMarker,
} from "./EventHub.official.fixture.ts";

for (const failure of [
  "subscriber-overflow",
  "parser",
  "eof",
  "missing-marker-keepalive",
] as const) {
  it(`installed official SSE ${failure} dirties owners without terminal claims, late generation delivery or unauthorized reopen`, async () => {
    const fixture = await officialV2EventFixture();
    const settings = await Effect.runPromise(
      makeTestSettings({
        providers: { opencodeV2: { enabled: true, nativeServiceTrust: "host-user-v1" } },
      }),
    );
    const consent = new V2ConsentAuthority(settings);
    const release = deferred<void>(),
      stalled = deferred<void>();
    const failures: string[] = [],
      dirty: string[] = [],
      delivered: string[] = [];
    let activities = 0;
    const hub = new OpencodeV2EventHub({
      maxOwners: 2,
      maxQueuedEvents: 8192,
      maxEventBytes: 100000,
      consumerTimeoutMs: 5000,
      requireMarker: true,
      subscribe: (signal, activity) => ({
        async *[Symbol.asyncIterator]() {
          const source = fixture.client.event.subscribe({
            signal,
            onActivity: () => {
              activities++;
              activity?.();
            },
          });
          try {
            for await (const event of source) {
              yield event;
              // Slow consumer of the real 4096-capacity subscriber, not an SDK queue replica.
              if (failure === "subscriber-overflow" && event.type === "server.connected") {
                stalled.resolve();
                await release.promise;
              }
            }
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      }),
    });
    hub.register({
      nativeSessionId: "ses_owned",
      location: "/synthetic/workspace",
      onDirty: (reason) => dirty.push(reason),
      onEvent: async (event, signal) => {
        signal.throwIfAborted();
        delivered.push(event.type);
      },
    });
    let keepalive: ReturnType<typeof setInterval> | undefined;
    try {
      const started = Date.now();
      await runAuthorizedV2(consent, fixture.transport, async () => hub.start());
      const response = await fixture.connected;
      if (failure !== "missing-marker-keepalive") response.write(officialSseMarker);
      if (failure === "subscriber-overflow") {
        await stalled.promise;
        response.write(
          Array.from({ length: 4098 }, (_, i) =>
            officialSseFrame({
              id: `evt_${i}`,
              type: "session.updated",
              location: { directory: "/synthetic/workspace" },
              data: { sessionID: "ses_owned" },
            }),
          ).join(""),
        );
        // Upstream shared subscriber keeps pulling in the background while its hub consumer is held.
        await expect.poll(() => fixture.closed, { timeout: 5000 }).toBeGreaterThan(0);
        release.resolve();
      } else if (failure === "parser") response.end("data: {invalid-json}\n\n");
      else if (failure === "eof") response.end();
      else keepalive = setInterval(() => response.write(": keepalive\n\n"), 25);
      await expect.poll(() => dirty.length, { timeout: 5000 }).toBeGreaterThan(0);
      expect(hub.isDirty("ses_owned")).toBe(true);
      expect(delivered).toEqual([]);
      if (failure === "subscriber-overflow")
        expect(failures.join(" ")).toContain("4096-event capacity");
      if (failure === "parser") expect(failures.length).toBe(1);
      if (failure === "missing-marker-keepalive") {
        expect(activities).toBeGreaterThan(5);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
        expect(Date.now() - started).toBeLessThan(4000);
      }
      const generation = hub.generation("ses_owned");
      await Effect.runPromise(
        settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } }),
      );
      const requests = fixture.requests;
      await expect(
        runAuthorizedV2(consent, fixture.transport, async () => hub.start()),
      ).rejects.toThrow("consent");
      expect(fixture.requests).toBe(requests);
      expect(hub.generation("ses_owned")).toBe(generation);
    } finally {
      release.resolve();
      if (keepalive) clearInterval(keepalive);
      await hub.close();
      consent.close();
      await fixture.close();
    }
  });
}
