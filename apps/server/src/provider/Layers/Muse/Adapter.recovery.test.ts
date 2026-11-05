import { MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  executeMuseRecovery,
  museRecoveryTerminalEvent,
  planMuseRecovery,
  scanMuseJournal,
} from "./Adapter.recovery.ts";

const threadId = ThreadId.makeUnsafe("thread-muse-recovery");

function row(input: {
  request: string;
  turn: string;
  state?: ProviderTurnAdmission["state"];
  outcome?: ProviderTurnAdmission["terminalOutcome"];
  createdAt: string;
}): ProviderTurnAdmission {
  return {
    namespace: "foreground",
    ownerThreadId: threadId,
    requestMessageId: MessageId.makeUnsafe(input.request),
    binding: {
      provider: "muse",
      threadId,
      nativeSessionId: "native-1",
      location: "/workspace",
      runtimeTargetId: "local",
      workspaceTargetId: "local",
      storageIdentity: "home",
    },
    fingerprint: "fp",
    nativeAdmissionId: input.turn,
    turnId: TurnId.makeUnsafe(input.turn),
    state: input.state ?? "accepted",
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    finalText: null,
    ...(input.outcome ? { terminalOutcome: input.outcome } : {}),
  };
}

/** In-memory journal honoring immutable-key pagination and journal transitions. */
function fakeAdmissions(initial: Array<ProviderTurnAdmission>) {
  const rows = initial.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const transitions: Array<string> = [];
  const find = (turnId: string) => rows.find((r) => r.turnId === turnId);
  return {
    rows,
    transitions,
    listBoundPage: (input: {
      threadId: ThreadId;
      limit: number;
      after?: Pick<
        ProviderTurnAdmission,
        "createdAt" | "namespace" | "ownerThreadId" | "requestMessageId"
      >;
    }) =>
      Effect.succeed(
        rows
          .filter((r) => r.binding.threadId === input.threadId)
          .filter(
            (r) =>
              !input.after ||
              `${r.createdAt}|${r.requestMessageId}` >
                `${input.after.createdAt}|${input.after.requestMessageId}`,
          )
          .slice(0, input.limit),
      ),
    transition: (
      current: ProviderTurnAdmission,
      state: string,
      _at: string,
      _f?: string,
      outcome?: ProviderTurnAdmission["terminalOutcome"],
    ) =>
      Effect.sync(() => {
        transitions.push(`${current.turnId}:${current.state}->${state}`);
        const stored = find(current.turnId)!;
        const next = {
          ...stored,
          state: state as ProviderTurnAdmission["state"],
          revision: stored.revision + 1,
          ...(outcome ? { terminalOutcome: outcome } : {}),
        };
        rows[rows.indexOf(stored)] = next;
        return next;
      }),
    settleProvenRefusal: () => Effect.die("unused"),
  };
}

describe("Muse journal recovery scan (Phase 3.11)", () => {
  it("pages beyond the first page and includes terminal evidence", async () => {
    const fake = fakeAdmissions([
      row({ request: "r1", turn: "t1", createdAt: "2026-10-29T00:00:01.000Z" }),
      row({ request: "r2", turn: "t2", createdAt: "2026-10-29T00:00:02.000Z" }),
      row({
        request: "r3",
        turn: "t3",
        state: "terminal",
        outcome: "completed",
        createdAt: "2026-10-29T00:00:03.000Z",
      }),
      row({ request: "r4", turn: "t4", createdAt: "2026-10-29T00:00:04.000Z" }),
      row({
        request: "r5",
        turn: "t5",
        state: "dispatch-intent",
        createdAt: "2026-10-29T00:00:05.000Z",
      }),
    ]);
    const scan = await Effect.runPromise(scanMuseJournal(fake as never, threadId, 2));
    expect(scan.pagesScanned).toBe(3);
    expect(scan.rows.map((r) => r.turnId)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    // Terminal row beyond the first page is present as delivery evidence.
    expect(scan.rows[2]?.state).toBe("terminal");
  });

  it("scans real bound rows past the first page in sqlite", async () => {
    const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        for (let i = 1; i <= 5; i++) {
          yield* journal.reserve({
            namespace: "foreground",
            ownerThreadId: threadId,
            requestMessageId: MessageId.makeUnsafe(`real-${i}`),
            binding: {
              provider: "muse",
              threadId,
              nativeSessionId: "native-1",
              location: "/workspace",
              runtimeTargetId: "local",
              workspaceTargetId: "local",
              storageIdentity: "home",
            },
            fingerprint: "fp",
            nativeAdmissionId: `turn-real-${i}`,
            turnId: TurnId.makeUnsafe(`turn-real-${i}`),
            createdAt: `2026-10-29T00:00:0${i}.000Z`,
          });
        }
        const first = yield* journal.reserve({
          namespace: "foreground",
          ownerThreadId: threadId,
          requestMessageId: MessageId.makeUnsafe("real-1"),
          binding: {
            provider: "muse",
            threadId,
            nativeSessionId: "native-1",
            location: "/workspace",
            runtimeTargetId: "local",
            workspaceTargetId: "local",
            storageIdentity: "home",
          },
          fingerprint: "fp",
          nativeAdmissionId: "turn-real-1",
          turnId: TurnId.makeUnsafe("turn-real-1"),
          createdAt: "2026-10-29T00:00:01.000Z",
        });
        const intent = yield* journal.transition(first, "dispatch-intent", first.createdAt);
        const accepted = yield* journal.transition(intent, "accepted", intent.createdAt);
        yield* journal.transition(accepted, "terminal", accepted.createdAt, undefined, "completed");
        const scan = yield* scanMuseJournal(journal, threadId, 2);
        expect(scan.pagesScanned).toBe(3);
        expect(scan.rows).toHaveLength(5);
        expect(scan.rows[0]?.state).toBe("terminal");
        expect(scan.rows[0]?.terminalOutcome).toBe("completed");
      }).pipe(Effect.provide(layer)),
    );
  });
});

describe("Muse recovery plan and execution (Phase 3.12/3.15)", () => {
  it("retains legacy terminal rows without an outcome as evidence, never completed redelivery", async () => {
    const legacy = row({
      request: "legacy",
      turn: "legacy-turn",
      state: "terminal",
      createdAt: "2026-10-29T00:00:00.000Z",
    });
    const plan = planMuseRecovery([legacy], {
      lastTurn: { turnId: legacy.turnId, terminal: "completed" },
    });
    expect(plan[0]?.kind).toBe("terminal-evidence");
    expect(() => museRecoveryTerminalEvent(threadId, legacy)).toThrow("durable terminal outcome");
    const fake = fakeAdmissions([legacy]);
    const published: Array<unknown> = [];
    const report = await Effect.runPromise(
      executeMuseRecovery({
        admissions: fake as never,
        threadId,
        scan: { rows: [legacy], pagesScanned: 1 },
        evidence: { lastTurn: { turnId: legacy.turnId, terminal: "completed" } },
        publish: (event) =>
          Effect.sync(() => {
            published.push(event);
          }),
      }),
    );
    expect(report.redelivered).toBe(0);
    expect(report.terminalEvidence).toBe(1);
    expect(published).toEqual([]);
  });
  it("classifies active, queued, last-turn, uncertain and terminal rows without inference", () => {
    const rows = [
      row({ request: "r1", turn: "active-1", createdAt: "2026-10-29T00:00:01.000Z" }),
      row({
        request: "r2",
        turn: "last-1",
        state: "dispatch-intent",
        createdAt: "2026-10-29T00:00:02.000Z",
      }),
      row({ request: "r3", turn: "mystery-1", createdAt: "2026-10-29T00:00:03.000Z" }),
      row({
        request: "r4",
        turn: "done-1",
        state: "terminal",
        outcome: "failed",
        createdAt: "2026-10-29T00:00:04.000Z",
      }),
    ];
    const plan = planMuseRecovery(rows, {
      activeTurnId: "active-1",
      lastTurn: { turnId: "last-1", terminal: "cancelled" },
    });
    expect(plan.map((a) => a.kind)).toEqual([
      "still-active",
      "settle-terminal",
      "uncertain",
      "terminal-evidence",
    ]);
    const settle = plan[1];
    expect(settle?.kind === "settle-terminal" && settle.outcome).toBe("interrupted");
  });

  it("settles only evidenced rows, republishes with a stable ID, and never touches uncertain rows", async () => {
    const fake = fakeAdmissions([
      row({
        request: "r1",
        turn: "last-1",
        state: "dispatch-intent",
        createdAt: "2026-10-29T00:00:01.000Z",
      }),
      row({ request: "r2", turn: "mystery-1", createdAt: "2026-10-29T00:00:02.000Z" }),
    ]);
    const published: Array<{ eventId: string; type: string }> = [];
    const publish = (event: { eventId: string; type: string }) =>
      Effect.sync(() => {
        published.push(event);
      });
    const report = await Effect.runPromise(
      executeMuseRecovery({
        admissions: fake as never,
        threadId,
        scan: { rows: fake.rows, pagesScanned: 1 },
        evidence: { lastTurn: { turnId: "last-1", terminal: "completed" } },
        publish: publish as never,
      }),
    );
    expect(report.settled).toBe(1);
    expect(report.uncertain).toBe(1);
    expect(report.redelivered).toBe(1);
    // dispatch-intent first advanced to accepted on the same evidence, then terminal.
    expect(fake.transitions).toEqual([
      "last-1:dispatch-intent->accepted",
      "last-1:accepted->terminal",
    ]);
    expect(published[0]?.eventId).toBe("muse-recovery-terminal-last-1");

    // Repeated recovery: the settled row is now terminal evidence/redelivery
    // with the SAME stable event ID and an unchanged outcome.
    const second: Array<{ eventId: string }> = [];
    const report2 = await Effect.runPromise(
      executeMuseRecovery({
        admissions: fake as never,
        threadId,
        scan: { rows: fake.rows, pagesScanned: 1 },
        evidence: { lastTurn: { turnId: "last-1", terminal: "completed" } },
        publish: ((event: { eventId: string }) =>
          Effect.sync(() => {
            second.push(event);
          })) as never,
      }),
    );
    expect(report2.settled).toBe(0);
    expect(report2.redelivered).toBe(1);
    expect(second[0]?.eventId).toBe(published[0]?.eventId);
    expect(fake.rows.find((r) => r.turnId === "last-1")?.terminalOutcome).toBe("completed");
  });

  it("recovery terminal events carry the journal outcome and a stable identity", () => {
    const failed = row({
      request: "r9",
      turn: "t9",
      state: "terminal",
      outcome: "failed",
      createdAt: "2026-10-29T00:00:09.000Z",
    });
    const event = museRecoveryTerminalEvent(threadId, failed);
    expect(event.type).toBe("turn.completed");
    expect((event.payload as { state?: string }).state).toBe("failed");
    expect(museRecoveryTerminalEvent(threadId, failed).eventId).toBe(event.eventId);
  });
});
