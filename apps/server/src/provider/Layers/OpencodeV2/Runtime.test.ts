import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { learningAdmissionIdentity } from "./Admission.identity.ts";

const threadId = ThreadId.makeUnsafe("executing-thread");
const modelSelection = {
  provider: "opencodeV2",
  model: "synthetic-model",
  subProviderID: "synthetic-provider",
} as const;
const requestMessageId = MessageId.makeUnsafe("durable-message");
const send = { threadId, requestMessageId, input: "synthetic prompt", modelSelection };

describe("isolated real V2 execution wiring", () => {
  it("dispatches resume:true after SQLite intent, repairs final output before settlement, persists usage and never re-executes retries", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      const result = await runtime.send(send);
      const row = runtime.get(threadId).row!;
      expect(row.state).toBe("terminal");
      expect(row.terminalOutcome).toBe("completed");
      expect(row.finalText).toBe("authoritative full output");
      const prompt = http.calls.find((call) => call.pathname.endsWith("/prompt"))!;
      expect(prompt.body.resume).toBe(true);
      expect(prompt.body.id).toBe(row.nativeAdmissionId);
      const finalIndex = events.findIndex((event) => event.type === "item.completed");
      const terminalIndex = events.findIndex((event) => event.type === "turn.completed");
      expect(finalIndex).toBeGreaterThan(-1);
      expect(terminalIndex).toBeGreaterThan(finalIndex);
      expect(events.some((event) => event.type === "thread.token-usage.updated")).toBe(true);
      for (const event of events) Schema.decodeUnknownSync(ProviderRuntimeEvent)(event);
      expect(await runtime.send(send)).toEqual(result);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      await expect(runtime.send({ ...send, input: "conflicting replay" })).rejects.toThrow();
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    });
  });

  it("repairs lost acknowledgement from exact projected input and never resends unknown admission", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      http.loseAck = true;
      await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      await expect(runtime.send(send)).rejects.toThrow();
      expect(runtime.get(threadId).row?.state).toBe("dispatch-intent");
      await runtime.reconcile(runtime.get(threadId));
      expect(runtime.get(threadId).row?.state).toBe("terminal");
      await runtime.send(send);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    });
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      http.loseAck = true;
      http.hideAdmission = true;
      await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      await expect(runtime.send(send)).rejects.toThrow();
      await runtime.reconcile(runtime.get(threadId));
      await expect(runtime.send(send)).rejects.toThrow();
      await expect(
        runtime.send({ ...send, requestMessageId: MessageId.makeUnsafe("new") }),
      ).rejects.toThrow("unresolved");
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      expect(runtime.get(threadId).row?.state).toBe("dispatch-intent");
    });
  });

  it("correlates failed and interrupted native outcomes without fabricated success", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      http.fail = true;
      await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      await runtime.send(send);
      expect(runtime.get(threadId).row?.terminalOutcome).toBe("failed");
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        state: "failed",
      });
    });
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      http.autoComplete = false;
      await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      await runtime.send(send);
      http.die();
      await runtime.sessions.get(threadId)!.operation;
      expect(runtime.sessions.get(threadId)!.row?.terminalOutcome).toBe("interrupted");
      expect(events.some((event) => event.type === "turn.aborted")).toBe(true);
    });
  });

  it("executes isolated durable learning once, reuses the retained result, and does not apply memory", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const review = makeV2LearningReview(runtime);
      const request = {
        ownerThreadId: threadId,
        jobId: "durable-job",
        modelSelection,
        cwd: directory,
        input: "review synthetic input",
      };
      expect(await Effect.runPromise(review(request))).toBe("authoritative full output");
      expect(await Effect.runPromise(review(request))).toBe("authoritative full output");
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      const identity = learningAdmissionIdentity(threadId, request.jobId);
      expect(
        (await Effect.runPromise(runtime.options.journal.find(identity.identity)))?.namespace,
      ).toBe("learning");
      expect(runtime.sessions.size).toBe(0);
    });
  });

  it("rejects remote modes, cross-storage resume, missing job ownership and ordinary workspaces before dispatch", async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      await expect(
        runtime.start({
          threadId,
          modelSelection,
          cwd: directory,
          runtimeMode: "approval-required",
          workspaceExecutionTargetId: "ssh:fixture",
        }),
      ).rejects.toThrow("remote");
      await expect(
        runtime.start({ threadId, modelSelection, cwd: "/", runtimeMode: "approval-required" }),
      ).rejects.toThrow("storage");
      const session = await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      await expect(
        runtime.send({ ...send, learningJob: { ownerThreadId: threadId, jobId: "wrong-owner" } }),
      ).rejects.toThrow("ownership");
      expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
      expect(session.resumeCursor).toMatchObject({ provider: "opencodeV2" });
    });
  });
});
