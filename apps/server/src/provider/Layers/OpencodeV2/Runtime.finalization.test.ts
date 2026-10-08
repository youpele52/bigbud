import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { deferred } from "./Test.fixtures.ts";
import type { FormDetail } from "@opencode/client";
import { Effect } from "effect";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

it("failed stop publication cannot skip native interrupt/release, retains exact bounded owner, and closes UI on recovery", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("stop-publication");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    const siblingId = ThreadId.makeUnsafe("stop-publication-sibling");
    await runtime.start({
      threadId: siblingId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const sibling = runtime.get(siblingId);
    http.forms.set(owner.native.id, [
      {
        id: "frm_stop_publish",
        sessionID: owner.native.id,
        title: "Choice",
        fields: [{ key: "answer", type: "string" }],
        state: { status: "pending" },
      },
    ]);
    for (const event of await pendingV2Interactions(owner)) await runtime.emit(owner, event);
    const interrupt = vi.spyOn(http.client.session, "interrupt");
    const release = vi.spyOn(owner.lease, "release");
    const sink = runtime.options.emit;
    let rejected = true;
    Object.assign(runtime.options, {
      emit: async (event: Parameters<typeof sink>[0]) => {
        if (rejected && event.type === "user-input.resolved")
          throw new Error("synthetic publication failure");
        await sink(event);
      },
    });
    await expect(runtime.stop(threadId)).rejects.toThrow();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(runtime.sessions.get(threadId)).toBe(owner);
    expect(runtime.teardown.has(threadId)).toBe(true);
    expect(runtime.get(siblingId)).toBe(sibling);
    await expect(
      runtime.start({ threadId, cwd: directory, modelSelection, runtimeMode: "approval-required" }),
    ).rejects.toThrow();
    rejected = false;
    await expect
      .poll(
        () =>
          events.filter((event) => event.threadId === threadId && event.type === "session.exited")
            .length,
      )
      .toBe(1);
    await expect.poll(() => runtime.teardown.has(threadId)).toBe(false);
    expect(
      events.filter((event) => event.threadId === threadId && event.type === "user-input.resolved"),
    ).toHaveLength(1);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const successor = runtime.get(threadId);
    await runtime.reconcile(owner);
    expect(runtime.get(threadId)).toBe(successor);
    expect(runtime.get(siblingId)).toBe(sibling);
    expect(
      events.filter((event) => event.threadId === threadId && event.type === "session.exited"),
    ).toHaveLength(1);
  });
});

it("confirmed loss commits interrupted once even when multiple request closures fail; stopped owner retries in order without resend", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("lost-publication");
    http.autoComplete = false;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await runtime.send({
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("lost-publication-input"),
      input: "synthetic",
    });
    const owner = runtime.get(threadId);
    http.forms.set(
      owner.native.id,
      ["first", "second"].map<FormDetail>((id) => ({
        id: `frm_${id}`,
        sessionID: owner.native.id,
        title: "Choice",
        fields: [{ key: "answer", type: "string" }],
        state: { status: "pending" },
      })),
    );
    http.permissions.set(owner.native.id, [
      {
        id: "per_lost_publish",
        sessionID: owner.native.id,
        action: "webfetch",
        resources: ["https://example.invalid"],
      },
    ]);
    await runtime.reconcile(owner);
    const transition = vi.spyOn(runtime.options.journal, "transition");
    const sink = runtime.options.emit;
    let rejected = true;
    Object.assign(runtime.options, {
      emit: async (event: Parameters<typeof sink>[0]) => {
        if (rejected && event.type === "user-input.resolved")
          throw new Error("synthetic loss publication failure");
        await sink(event);
      },
    });
    http.die();
    await expect.poll(() => owner.row?.terminalOutcome).toBe("interrupted");
    expect(await Effect.runPromise(runtime.options.journal.latestBound(threadId))).toMatchObject({
      state: "terminal",
      terminalOutcome: "interrupted",
    });
    expect(transition.mock.calls.filter((call) => call[1] === "terminal")).toHaveLength(1);
    expect(events.some((event) => event.type === "session.exited")).toBe(false);
    expect(owner.pendingInteractions?.size).toBe(2);
    rejected = false;
    await expect.poll(() => events.some((event) => event.type === "session.exited")).toBe(true);
    expect(owner.pendingInteractions?.size).toBe(0);
    const types = events
      .filter((event) =>
        ["request.resolved", "user-input.resolved", "turn.aborted", "session.exited"].includes(
          event.type,
        ),
      )
      .map((event) => event.type);
    expect(types).toEqual([
      "request.resolved",
      "user-input.resolved",
      "user-input.resolved",
      "turn.aborted",
      "session.exited",
    ]);
    await runtime.reconcile(owner);
    expect(transition.mock.calls.filter((call) => call[1] === "terminal")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.aborted")).toHaveLength(1);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});

it("custom multiselect native reply preserves two custom entries and selected exact IDs", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("custom-multiple");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    http.forms.set(owner.native.id, [
      {
        id: "frm_custom",
        sessionID: owner.native.id,
        title: "Tags",
        fields: [
          {
            key: "tags",
            type: "multiselect",
            required: true,
            custom: true,
            minItems: 2,
            options: [{ value: "exact", label: "Display" }],
          },
        ],
        state: { status: "pending" },
      },
    ]);
    await runtime.respondForm(threadId, "frm_custom", { tags: ["exact", "a,b", "line\nbreak"] });
    expect(
      http.calls.filter((call) => call.pathname.endsWith("/reply")).map((call) => call.body),
    ).toEqual([{ answer: { tags: ["exact", "a,b", "line\nbreak"] } }]);
  });
});

it("a hung canonical sink has a bounded wait and late settlement is joined, not dispatched twice", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("hung-publication");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    http.forms.set(owner.native.id, [
      {
        id: "frm_hung",
        sessionID: owner.native.id,
        title: "Choice",
        fields: [{ key: "answer", type: "string" }],
        state: { status: "pending" },
      },
    ]);
    for (const event of await pendingV2Interactions(owner)) await runtime.emit(owner, event);
    const sink = runtime.options.emit;
    const entered = deferred<void>();
    const gate = deferred<void>();
    let calls = 0;
    Object.assign(runtime.options, {
      emit: async (event: Parameters<typeof sink>[0]) => {
        if (event.type === "user-input.resolved") {
          calls++;
          entered.resolve();
          await gate.promise;
        }
        await sink(event);
      },
    });
    vi.useFakeTimers();
    try {
      const stopping = runtime.stop(threadId);
      const rejected = expect(stopping).rejects.toThrow();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1001);
      await rejected;
      expect(runtime.teardown.has(threadId)).toBe(true);
      await vi.advanceTimersByTimeAsync(1001);
      expect(calls).toBe(1);
      gate.resolve();
      vi.useRealTimers();
      await expect
        .poll(() => events.filter((event) => event.type === "session.exited").length)
        .toBe(1);
      expect(calls).toBe(1);
      expect(owner.pendingInteractions?.size).toBe(0);
      expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
      expect(runtime.teardown.has(threadId)).toBe(false);
    } finally {
      gate.resolve();
      vi.useRealTimers();
    }
  });
});
