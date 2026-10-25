import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it, vi } from "vitest";
import {
  createRuntime,
  engineFor,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { getThreadStatusViaOrchestration } from "./ThreadOrchestrationTools.ts";
import { listThreadsViaOrchestration } from "./ThreadOrchestrationTools.listThreads.ts";
import { sendThreadMessageViaOrchestration } from "./ThreadOrchestrationTools.sendMessage.ts";
import {
  callerId,
  targetId,
  unrelatedId,
  projectId,
  withDormantThreads,
} from "./ThreadOrchestrationTools.restart.fixture.ts";

it.each(["status", "send"] as const)(
  "%s resolves persisted dormant participants after a real engine restart without prior attachment",
  async (operation) => {
    await withDormantThreads({}, async ({ engine, runtime, repository, catalog }) => {
      const args = {
        orchestrationEngine: engine,
        threadDelegationRepository: repository,
        callerThreadId: callerId,
        threadId: targetId,
      };
      expect(
        (
          await runtime.runPromise(
            listThreadsViaOrchestration({
              projectionCatalogQuery: catalog,
              callerThreadId: callerId,
            }),
          )
        ).threads.map((t) => t.threadId),
      ).toContain(targetId);
      expect((await runtime.runPromise(engine.getReadModel())).threads).toEqual([]);
      const before = (await runtime.runPromise(engine.getReadModel())).snapshotSequence;
      if (operation === "status") {
        expect(await runtime.runPromise(getThreadStatusViaOrchestration(args))).toMatchObject({
          threadId: targetId,
          workflowStatus: "idle",
        });
        expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(before);
      } else {
        const send = {
          ...args,
          message: "canonical dormant delivery",
          delivery: "queue" as const,
          invocationId: "restart-send",
        };
        const outcome = await runtime.runPromise(sendThreadMessageViaOrchestration(send));
        expect(outcome).toMatchObject({ delivery: "queued" });
        const sequence = (await runtime.runPromise(engine.getReadModel())).snapshotSequence;
        expect(await runtime.runPromise(sendThreadMessageViaOrchestration(send))).toEqual(outcome);
        expect((await runtime.runPromise(engine.getReadModel())).snapshotSequence).toBe(sequence);
        const queued =
          (await runtime.runPromise(engine.getReadModel())).threads.find((t) => t.id === targetId)!
            .queuedPrompts ?? [];
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({
          text: send.message,
          originSegments: [
            { kind: "crossThreadAgent", verified: true, sourceThreads: [{ threadId: callerId }] },
          ],
        });
      }
      const model = await runtime.runPromise(engine.getReadModel());
      expect(model.threads.map((t) => t.id).toSorted()).toEqual([callerId, targetId].toSorted());
      expect(model.threads.find((t) => t.id === targetId)).toMatchObject({
        projectId,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        session: null,
      });
      expect(model.threads.map((t) => t.id)).not.toContain(unrelatedId);
      expect(model.projects).toEqual([
        expect.objectContaining({
          id: projectId,
          title: "Recovery",
          workspaceRoot: expect.any(String),
        }),
      ]);
    });
  },
);

it.each(["codex", "pi"] as const)(
  "canonical sends preserve the dormant target's independent %s model",
  async (provider) => {
    await withDormantThreads({ provider }, async ({ engine, runtime, repository }) => {
      await runtime.runPromise(
        sendThreadMessageViaOrchestration({
          orchestrationEngine: engine,
          threadDelegationRepository: repository,
          callerThreadId: callerId,
          threadId: targetId,
          message: "start on target provider",
          delivery: "auto",
          invocationId: "auto-start",
        }),
      );
      const replay = await runtime.runPromise(engine.readReplay(0));
      expect(replay.events.filter((e) => e.type === "thread.turn-start-requested")).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ threadId: targetId }) }),
      ]);
      expect(
        (await runtime.runPromise(engine.getReadModel())).threads.find((t) => t.id === targetId)
          ?.modelSelection.provider,
      ).toBe(provider);
      expect(
        replay.events.find((e) => e.type === "thread.turn-start-requested")?.payload,
      ).not.toHaveProperty("modelSelection");
    });
  },
);

it("replays one exact canonical send after a second engine restart without a duplicate inbox event", async () => {
  await withDormantThreads({}, async ({ engine, runtime, repository, dbPath }) => {
    const args = {
      threadDelegationRepository: repository,
      callerThreadId: callerId,
      threadId: targetId,
      message: "durable exact invocation",
      delivery: "queue" as const,
      invocationId: "receipt-across-restart",
    };
    const accepted = await runtime.runPromise(
      sendThreadMessageViaOrchestration({ ...args, orchestrationEngine: engine }),
    );
    const before = (await runtime.runPromise(engine.readReplay(0))).events;
    await runtime.dispose();
    const second = createRuntime(dbPath);
    try {
      const resumed = await engineFor(second);
      expect(
        await second.runPromise(
          sendThreadMessageViaOrchestration({ ...args, orchestrationEngine: resumed }),
        ),
      ).toEqual(accepted);
      expect((await second.runPromise(resumed.readReplay(0))).events).toEqual(before);
      expect(
        (await second.runPromise(resumed.getReadModel())).threads.find((t) => t.id === targetId)
          ?.queuedPrompts,
      ).toHaveLength(1);
    } finally {
      await second.dispose();
    }
  });
});

it("self status resolves the authenticated caller once and warms no other dormant participant", async () => {
  await withDormantThreads({}, async ({ engine, runtime, repository }) => {
    const ensure = vi.spyOn(engine, "ensureThreadState");
    expect(
      await runtime.runPromise(
        getThreadStatusViaOrchestration({
          orchestrationEngine: engine,
          threadDelegationRepository: repository,
          callerThreadId: callerId,
          threadId: callerId,
        }),
      ),
    ).toMatchObject({ threadId: callerId });
    expect(ensure.mock.calls).toEqual([[callerId, "operational"]]);
    expect((await runtime.runPromise(engine.getReadModel())).threads.map((t) => t.id)).toEqual([
      callerId,
    ]);
    expect(
      (await runtime.runPromise(engine.readReplay(0))).events.every(
        (e) => e.type === "thread.created" || e.type === "project.created",
      ),
    ).toBe(true);
  });
});

it.each([false, true])(
  "post-restart direct-child cross-project access, delegated=%s",
  async (delegated) => {
    await withDormantThreads(
      { foreign: true, delegated },
      async ({ engine, runtime, repository }) => {
        const args = {
          orchestrationEngine: engine,
          threadDelegationRepository: repository,
          callerThreadId: callerId,
          threadId: targetId,
        };
        if (delegated) {
          expect(await runtime.runPromise(getThreadStatusViaOrchestration(args))).toMatchObject({
            threadId: targetId,
          });
          expect(
            await runtime.runPromise(
              sendThreadMessageViaOrchestration({
                ...args,
                message: "child",
                delivery: "queue",
                invocationId: "child-call",
              }),
            ),
          ).toMatchObject({ delivery: "queued" });
        } else {
          await expect(runtime.runPromise(getThreadStatusViaOrchestration(args))).rejects.toThrow(
            "not accessible",
          );
          await expect(
            runtime.runPromise(
              sendThreadMessageViaOrchestration({
                ...args,
                message: "foreign",
                delivery: "queue",
                invocationId: "foreign-call",
              }),
            ),
          ).rejects.toThrow("not accessible");
        }
      },
    );
  },
);

it.each(["deleted", "deleting", "archived", "missing"] as const)(
  "post-restart %s targets retain status/send restrictions",
  async (state) => {
    await withDormantThreads({ [state]: true }, async ({ engine, runtime, repository }) => {
      const args = {
        orchestrationEngine: engine,
        threadDelegationRepository: repository,
        callerThreadId: callerId,
        threadId: state === "missing" ? ThreadId.makeUnsafe("missing") : targetId,
      };
      if (state === "archived")
        expect(await runtime.runPromise(getThreadStatusViaOrchestration(args))).toMatchObject({
          workflowStatus: "archived",
        });
      else
        await expect(runtime.runPromise(getThreadStatusViaOrchestration(args))).rejects.toThrow(
          /not found|being deleted/,
        );
      await expect(
        runtime.runPromise(
          sendThreadMessageViaOrchestration({
            ...args,
            message: "forbidden",
            delivery: "auto",
            invocationId: "denied-call",
          }),
        ),
      ).rejects.toThrow(/not found|not available|being deleted/);
    });
  },
);
