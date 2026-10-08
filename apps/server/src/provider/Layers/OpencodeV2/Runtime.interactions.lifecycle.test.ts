import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { deferred } from "./Test.fixtures.ts";
import type { FormDetail } from "@opencode/client";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

it("normal native form flow exposes typed fields, blocks invalid answers before mutation and posts exact typed answers once", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("typed-flow");
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
      requestMessageId: MessageId.makeUnsafe("typed"),
      input: "synthetic",
    });
    const session = runtime.get(threadId);
    http.forms.set(session.native.id, [
      {
        id: "frm_flow",
        sessionID: session.native.id,
        title: "Setup",
        state: { status: "pending" },
        fields: [
          {
            key: "choice",
            type: "string",
            required: true,
            options: [
              { value: "one", label: "Same" },
              { value: "two", label: "Same" },
            ],
          },
          { key: "enabled", type: "boolean", required: true },
          { key: "count", type: "integer", required: true, minimum: 1, maximum: 3 },
          { key: "note", type: "string" },
        ],
      },
    ]);
    await runtime.reconcile(session);
    expect(events.find((event) => event.type === "user-input.requested")).toMatchObject({
      payload: {
        questions: [
          { id: "choice", field: { required: true, allowCustom: false } },
          { id: "enabled", options: [{ id: "true" }, { id: "false" }] },
          { id: "count" },
          { id: "note", field: { required: false } },
        ],
      },
    });
    await expect(
      runtime.respondForm(threadId, "frm_flow", { choice: "Same", enabled: "false", count: "2" }),
    ).rejects.toThrow("invalid");
    expect(http.calls.filter((call) => call.pathname.endsWith("/reply"))).toHaveLength(0);
    await runtime.respondForm(threadId, "frm_flow", {
      choice: "two",
      enabled: "false",
      count: "2",
    });
    await runtime.reconcile(session);
    expect(
      http.calls.filter((call) => call.pathname.endsWith("/reply")).map((call) => call.body),
    ).toEqual([{ answer: { choice: "two", enabled: false, count: 2 } }]);
    expect(events.filter((event) => event.type === "user-input.resolved")).toHaveLength(1);
    await expect(
      runtime.respondForm(threadId, "frm_flow", { choice: "two", enabled: "false", count: "2" }),
    ).rejects.toThrow("stale");
    http.complete(session.native.id);
    await runtime.reconcile(session);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });
});

it("an externally answered form closes with authoritative answers rather than fabricated cancellation", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("external-form");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const session = runtime.get(threadId);
    const form: FormDetail = {
      id: "frm_external",
      sessionID: session.native.id,
      title: "Choice",
      fields: [{ key: "answer", type: "string" }],
      state: { status: "pending" },
    };
    http.forms.set(session.native.id, [form]);
    for (const event of await pendingV2Interactions(session)) await runtime.emit(session, event);
    http.forms.set(session.native.id, [
      { ...form, state: { status: "answered", answer: { answer: "authoritative" } } },
    ]);
    for (const event of await pendingV2Interactions(session)) await runtime.emit(session, event);
    expect(events.find((event) => event.type === "user-input.resolved")?.payload).toEqual({
      answers: { answer: "authoritative" },
    });
  });
});

it("a failed canonical resolution sink retains interaction ownership for lossless repair", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("form-sink-failure");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const session = runtime.get(threadId);
    const form: FormDetail = {
      id: "frm_sink",
      sessionID: session.native.id,
      title: "Choice",
      fields: [{ key: "answer", type: "string" }],
      state: { status: "pending" },
    };
    http.forms.set(session.native.id, [form]);
    for (const event of await pendingV2Interactions(session)) await runtime.emit(session, event);
    form.state = { status: "cancelled" };
    const sink = vi
      .spyOn(runtime.options, "emit")
      .mockRejectedValueOnce(new Error("synthetic sink failure"));
    await expect(runtime.emit(session, (await pendingV2Interactions(session))[0]!)).rejects.toThrow(
      "sink",
    );
    expect(session.pendingInteractions?.size).toBe(1);
    sink.mockRestore();
    for (const event of await pendingV2Interactions(session)) await runtime.emit(session, event);
    expect(session.pendingInteractions?.size).toBe(0);
    expect(events.filter((event) => event.type === "user-input.resolved")).toHaveLength(1);
  });
});

it("native cancellation closes the canonical form once without pretending it was answered", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("cancel-form");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const session = runtime.get(threadId);
    const form = {
      id: "form_cancel",
      sessionID: session.native.id,
      title: "Choice",
      fields: [{ key: "answer", type: "string", required: true }],
    } as const;
    const listing = vi.spyOn(http.client.session.form, "list").mockResolvedValue([form] as never);
    for (const event of await pendingV2Interactions(session)) await runtime.emit(session, event);
    listing.mockResolvedValue([]);
    vi.spyOn(http.client.session.form, "get").mockResolvedValue({
      ...form,
      state: { status: "cancelled" },
    } as never);
    for (let i = 0; i < 2; i++)
      for (const event of await pendingV2Interactions(session)) await runtime.emit(session, event);
    expect(events.filter((event) => event.type === "user-input.resolved")).toHaveLength(1);
    expect(events.find((event) => event.type === "user-input.resolved")?.payload).toEqual({
      answers: {},
    });
  });
});

it("a form settled during namespace wait is not replied to again and does not quarantine an undispatched mutation", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("stale-form");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const session = runtime.get(threadId);
    const form = {
      id: "form_stale",
      sessionID: session.native.id,
      title: "Choice",
      fields: [{ key: "answer", type: "string", required: true }],
      state: { status: "pending" },
    };
    const read = vi.spyOn(http.client.session.form, "get").mockResolvedValue(form as never);
    const reply = vi.spyOn(http.client.session.form, "reply").mockResolvedValue(undefined);
    const entered = deferred<void>();
    const release = deferred<void>();
    const held = runtime.mutations.withNamespace(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = runtime.respondForm(threadId, form.id, { answer: "safe" });
    const rejected = expect(pending).rejects.toThrow("stale");
    await expect.poll(() => read.mock.calls.length).toBe(1);
    read.mockResolvedValue({ ...form, state: { status: "cancelled" } } as never);
    release.resolve();
    await held;
    await rejected;
    expect(reply).not.toHaveBeenCalled();
    expect(() => runtime.mutations.assertSafe()).not.toThrow();
  });
});

it("a permission changed during namespace wait cannot use an approval for its previous resources", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    Object.assign(runtime.options, { enableLocalTools: true });
    const threadId = ThreadId.makeUnsafe("stale-permission");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const session = runtime.get(threadId);
    const request = {
      id: "per_changed",
      sessionID: session.native.id,
      action: "webfetch",
      resources: ["https://example.invalid/first"],
    };
    const read = vi.spyOn(http.client.permission, "get").mockResolvedValue(request);
    const reply = vi.spyOn(http.client.permission, "reply").mockResolvedValue(undefined);
    const entered = deferred<void>();
    const release = deferred<void>();
    const held = runtime.mutations.withNamespace(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = runtime.respondPermission(threadId, request.id, "accept");
    const rejected = expect(pending).rejects.toThrow("stale");
    await expect.poll(() => read.mock.calls.length).toBe(1);
    read.mockResolvedValue({ ...request, resources: ["https://example.invalid/changed"] });
    release.resolve();
    await held;
    await rejected;
    expect(reply).not.toHaveBeenCalled();
    expect(() => runtime.mutations.assertSafe()).not.toThrow();
  });
});

it("logical stop closes pending form UI without sending a form answer or allowing stale reply", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("stopped-form");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const session = runtime.get(threadId);
    http.forms.set(session.native.id, [
      {
        id: "frm_stop",
        sessionID: session.native.id,
        title: "Choice",
        fields: [{ key: "answer", type: "string" }],
        state: { status: "pending" },
      },
    ]);
    for (const event of await pendingV2Interactions(session)) await runtime.emit(session, event);
    await runtime.stop(threadId);
    expect(events.filter((event) => event.type === "user-input.resolved")).toHaveLength(1);
    expect(http.calls.some((call) => call.pathname.endsWith("/reply"))).toBe(false);
    await expect(runtime.respondForm(threadId, "frm_stop", { answer: "late" })).rejects.toThrow(
      "not owned",
    );
  });
});

it("lost accepted execution invalidates forms and approvals before reporting interrupted, not unconfirmed", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("lost-form");
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
      requestMessageId: MessageId.makeUnsafe("lost"),
      input: "synthetic",
    });
    const session = runtime.get(threadId);
    vi.spyOn(http.client.permission, "list").mockResolvedValue([
      {
        id: "per_lost",
        sessionID: session.native.id,
        action: "webfetch",
        resources: ["https://example.invalid"],
      },
    ]);
    vi.spyOn(http.client.session.form, "list").mockResolvedValue([
      {
        id: "form_lost",
        sessionID: session.native.id,
        title: "Choice",
        fields: [{ key: "answer", type: "string" }],
      },
    ] as never);
    await runtime.reconcile(session);
    http.die();
    await expect.poll(() => events.some((event) => event.type === "session.exited")).toBe(true);
    expect(events.filter((event) => event.type === "user-input.resolved")).toHaveLength(1);
    expect(events.filter((event) => event.type === "request.resolved")).toHaveLength(1);
    expect(session.row?.terminalOutcome).toBe("interrupted");
    expect(events.findIndex((event) => event.type === "user-input.resolved")).toBeLessThan(
      events.findIndex((event) => event.type === "turn.aborted"),
    );
  });
});
