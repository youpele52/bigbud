import { expect, it } from "vitest";
import { readRetainedFamilySqlSnapshots } from "./ProjectionSnapshotQuery.family.fixture.ts";

it("persists cardless Stop authority through SQLite full/mobile/operational queries and clears false or legacy-unset updates", async () => {
  const results = await readRetainedFamilySqlSnapshots();
  expect(results.map((row) => row.expected)).toEqual([false, true, false, true, false]);
  for (const row of results) {
    expect(row.stored).toBe(row.expected);
    expect(row.raw).toBe(row.expected ? 1 : 0);
    expect(row.mobileSelected).toBe(row.expected);
    for (const snapshot of [row.snapshot, row.mobile, row.threadOperational, row.history]) {
      const thread = snapshot.threads.find((item) => item.id === "retained-family-sql")!;
      expect(thread.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        retainedFamily: row.expected,
      });
      expect(thread.tasks ?? []).toEqual([]);
    }
    // Idle roots with no cards must remain in startup operational recovery while retained.
    expect(row.operational.threads.some((thread) => thread.id === "retained-family-sql")).toBe(
      row.expected,
    );
  }
});

it("publishes retained-family Stop authority through the bounded web startup catalogs", async () => {
  const results = await readRetainedFamilySqlSnapshots();
  expect(results.map((row) => row.expected)).toEqual([false, true, false, true, false]);
  for (const row of results) {
    // The web hydrates from these summaries at startup, not from getSnapshot.
    for (const summary of [row.sidebarSummary, row.projectSummary]) {
      expect(summary).toMatchObject({
        sessionStatus: "ready",
        activeTurnId: null,
        retainedFamily: row.expected,
      });
    }
  }
});
