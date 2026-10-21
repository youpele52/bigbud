import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT } from "@bigbud/contracts/constants/connectionDiagnostics.constant.ts";

import { BoundedRing } from "./ConnectionDiagnostics.ring.ts";
import { makeConnectionDiagnostics } from "./Layers/ConnectionDiagnostics.ts";

describe("BoundedRing", () => {
  it("keeps only the newest entries, newest first", () => {
    const ring = new BoundedRing<number>(3);
    for (const value of [1, 2, 3, 4, 5]) ring.push(value);

    expect(ring.length).toBe(3);
    expect(ring.newest()).toEqual([5, 4, 3]);
    expect(ring.newest(2)).toEqual([5, 4]);
    expect(ring.newest(0)).toEqual([]);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new BoundedRing<number>(0)).toThrow();
  });
});

const report = (attempt: number) => ({ trigger: "close" as const, attempt, closeCode: 1006 });

describe("makeConnectionDiagnostics", () => {
  it("bounds the report ring and numbers reports monotonically", async () => {
    const diagnostics = makeConnectionDiagnostics({ reportCapacity: 3 });
    const entries = await Effect.runPromise(
      Effect.forEach([1, 2, 3, 4, 5], (attempt) => diagnostics.recordReport(report(attempt))),
    );
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);

    const snapshot = await Effect.runPromise(diagnostics.snapshot(10));
    expect(snapshot.reports.map((entry) => entry.attempt)).toEqual([5, 4, 3]);
    expect(snapshot.reports[0]?.closeCode).toBe(1006);
  });

  it("returns the default read limit and clamps oversized reads", async () => {
    const diagnostics = makeConnectionDiagnostics();
    await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT + 10 }),
        (_, i) => diagnostics.recordReport(report(i)),
      ),
    );

    expect((await Effect.runPromise(diagnostics.snapshot())).reports).toHaveLength(20);
    expect((await Effect.runPromise(diagnostics.snapshot(10_000))).reports).toHaveLength(
      WS_CONNECTION_DIAGNOSTICS_READ_MAX_LIMIT,
    );
  });

  it("keeps server events in their own bounded ring", async () => {
    const diagnostics = makeConnectionDiagnostics({ serverEventCapacity: 2 });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* diagnostics.recordReport(report(1));
        for (const reason of ["client-close", "overflow", "server-shutdown"] as const) {
          yield* diagnostics.recordDeliverySessionEnded({
            consumerId: "consumer-a",
            reason,
            durationMs: 12.4,
          });
        }
      }),
    );

    const snapshot = await Effect.runPromise(diagnostics.snapshot());
    expect(snapshot.reports).toHaveLength(1);
    expect(
      snapshot.serverEvents.map((event) =>
        event.type === "delivery-session-ended" ? event.reason : event.type,
      ),
    ).toEqual(["server-shutdown", "overflow"]);
    expect(snapshot.serverEvents[0]).toMatchObject({ consumerId: "consumer-a", durationMs: 12 });
  });

  it("records a suspected system sleep as its own server event", async () => {
    const diagnostics = makeConnectionDiagnostics();
    await Effect.runPromise(
      diagnostics.recordSuspectedSystemSleep({ endedAtMs: 1_800_000, durationMs: 600_000.4 }),
    );

    const snapshot = await Effect.runPromise(diagnostics.snapshot());
    expect(snapshot.serverEvents).toEqual([
      {
        type: "suspected-system-sleep",
        sequence: 1,
        startedAt: new Date(1_200_000).toISOString(),
        endedAt: new Date(1_800_000).toISOString(),
        durationMs: 600_000,
      },
    ]);
  });
});
