import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { EventId, MessageId, RuntimeRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

it("blocks a fresh admission behind a locally known interaction with an explicitly non-replayable hold", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("pending-interaction");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const session = runtime.get(threadId);
    session.pendingInteractions = new Map([
      [
        "request.opened:permission",
        {
          type: "request.opened",
          provider: "opencodeV2",
          eventId: EventId.makeUnsafe("open"),
          requestId: RuntimeRequestId.makeUnsafe("permission"),
          threadId,
          createdAt: new Date().toISOString(),
          payload: { requestType: "command_execution_approval" },
        },
      ],
    ]);
    await expect(
      runtime.send({
        threadId,
        requestMessageId: MessageId.makeUnsafe("would-send"),
        input: "chat",
      }),
    ).rejects.toMatchObject({
      failureClass: "invalid-request",
      turnStartRefusal: { gate: { manualRecovery: "discard-and-resend" } },
    });
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    expect(await Effect.runPromise(runtime.options.journal.latestBound(threadId))).toBeUndefined();
  });
});

it("reopens a locally refused exact intent and sends once after native form closure", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("late-form");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const session = runtime.get(threadId);
    const requestId = RuntimeRequestId.makeUnsafe("frm_late");
    const journal = runtime.options.journal;
    const transition = journal.transition;
    let inject = true;
    const spy = vi.spyOn(journal, "transition").mockImplementation((...args) =>
      transition(...args).pipe(
        Effect.tap((row) =>
          Effect.sync(() => {
            if (!inject || row.state !== "dispatch-intent") return;
            inject = false;
            session.pendingInteractions = new Map([
              [
                `user-input.requested:${requestId}`,
                {
                  type: "user-input.requested",
                  provider: "opencodeV2",
                  eventId: EventId.makeUnsafe("late-form-event"),
                  requestId,
                  requestGeneration: "exact-generation",
                  threadId,
                  createdAt: new Date().toISOString(),
                  sessionEpoch: session.epoch,
                  payload: { questions: [] },
                },
              ],
            ]);
            http.forms.set(session.native.id, [
              {
                id: requestId,
                sessionID: session.native.id,
                title: "Question",
                fields: [{ key: "answer", type: "string" }],
                state: { status: "pending" },
              },
            ]);
          }),
        ),
      ),
    );
    try {
      const input = {
        threadId,
        requestMessageId: MessageId.makeUnsafe("same-message"),
        input: "work",
      };
      await expect(runtime.send(input)).rejects.toMatchObject({
        turnStartRefusal: { gate: { provider: "opencodeV2" } },
      });
      const reserved = await Effect.runPromise(journal.latestBound(threadId));
      expect(reserved).toMatchObject({ state: "reserved", revision: 2 });
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      await runtime.respondForm(threadId, requestId, { answer: "continue" });
      await runtime.send(input);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      expect(await Effect.runPromise(journal.latestBound(threadId))).toMatchObject({
        nativeAdmissionId: reserved?.nativeAdmissionId,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

for (const path of ["replay", "ack"] as const) {
  for (const race of ["epoch", "dirty-generation", "hub-generation"] as const) {
    it(`runtime.send ${path} retains uncertain admission after ${race} supersedes its original owner`, async () => {
      await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
        const repair = vi.spyOn(runtime, "scheduleRepair").mockImplementation(() => {});
        http.autoComplete = false;
        const threadId = ThreadId.makeUnsafe(`${path}-${race}`);
        const input = {
          threadId,
          requestMessageId: MessageId.makeUnsafe("admission-fence"),
          input: "unchanged fixture bytes",
        };
        await runtime.start({
          threadId,
          cwd: directory,
          runtimeMode: "approval-required",
          modelSelection: {
            provider: "opencodeV2",
            subProviderID: "synthetic-provider",
            model: "synthetic-model",
          },
        });
        const owner = runtime.get(threadId);
        if (path === "replay") {
          http.loseAck = true;
          await expect(runtime.send(input)).rejects.toThrow();
          http.loseAck = false;
        }
        const before = await Effect.runPromise(runtime.options.journal.latestBound(threadId));
        const entered = deferred<void>(),
          hold = deferred<void>();
        // The official client response is already decoded; hold its awaited result at the admission boundary.
        const pause = async <T>(run: () => Promise<T>) => {
          const value = await run();
          entered.resolve();
          await hold.promise;
          return value;
        };
        const list = http.client.session.inbox.list.bind(http.client.session.inbox);
        const prompt = http.client.session.prompt.bind(http.client.session);
        const read =
          path === "replay"
            ? vi
                .spyOn(http.client.session.inbox, "list")
                .mockImplementation((...args) => pause(() => list(...args)))
            : vi
                .spyOn(http.client.session, "prompt")
                .mockImplementation((...args) => pause(() => prompt(...args)));
        try {
          const pending = runtime.send(input);
          const rejected = expect(pending).rejects.toThrow();
          await entered.promise;
          if (race === "epoch") Object.assign(owner, { epoch: owner.epoch + 1 });
          else if (race === "dirty-generation") owner.dirtyGeneration++;
          else owner.lease.hub.markGap();
          hold.resolve();
          await rejected;
          const after = await Effect.runPromise(runtime.options.journal.latestBound(threadId));
          expect(after?.state).toBe("dispatch-intent");
          if (before) expect(after).toEqual(before);
          expect(owner.row?.state).not.toBe("accepted");
          expect(events.some((event) => event.type === "turn.started")).toBe(false);
          expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
        } finally {
          hold.resolve();
          read.mockRestore();
          repair.mockRestore();
        }
      });
    });
  }
}
