import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { boundedV2ApprovalIntent, v2PermissionFingerprint } from "./Runtime.approvalIntent.ts";

const modelSelection = {
  provider: "opencodeV2",
  model: "synthetic-model",
  subProviderID: "synthetic-provider",
} as const;
for (const oversized of ["resource", "arguments"] as const) {
  it(`normal discovery immediately rejects oversized ${oversized} intent with bounded publication while unrelated permission/form remains usable`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      http.autoComplete = false;
      Object.assign(runtime.options, { enableLocalTools: true, pollIntervalMs: 100000 });
      const threadId = ThreadId.makeUnsafe(`oversized-${oversized}`);
      await runtime.start({
        threadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe(oversized),
        input: "synthetic",
      });
      const owner = runtime.get(threadId),
        huge = "X".repeat(66000);
      http.permissions.set(owner.native.id, [
        {
          id: "per_oversized",
          sessionID: owner.native.id,
          action: "shell",
          resources: [oversized === "resource" ? huge : "echo bounded"],
          ...(oversized === "arguments" ? { metadata: { arguments: { command: huge } } } : {}),
        },
        {
          id: "per_normal",
          sessionID: owner.native.id,
          action: "webfetch",
          resources: ["https://synthetic.invalid"],
          message: "Normal request",
        },
      ]);
      http.forms.set(owner.native.id, [
        {
          id: "frm_normal",
          sessionID: owner.native.id,
          title: "Normal form",
          fields: [{ key: "answer", type: "string" }],
          state: { status: "pending" },
        },
      ]);
      const nativeReply = http.client.permission.reply;
      const reply = vi
        .spyOn(http.client.permission, "reply")
        .mockImplementation(async (...args) => {
          const result = await nativeReply(...args);
          http.permissions.set(
            owner.native.id,
            http.permissions
              .get(owner.native.id)!
              .filter((request) => request.id !== args[0].requestID),
          );
          return result;
        });
      await runtime.reconcile(owner);
      expect(reply.mock.calls.map(([input]) => [input.requestID, input.decision])).toEqual([
        ["per_oversized", "reject"],
      ]);
      expect(
        events.find(
          (event) => event.type === "request.resolved" && event.requestId === "per_oversized",
        ),
      ).toMatchObject({
        payload: {
          decision: "decline",
          resolution: { reason: expect.stringContaining("inspectable bound") },
        },
      });
      expect(
        events.some(
          (event) => event.type === "request.opened" && event.requestId === "per_oversized",
        ),
      ).toBe(false);
      expect(JSON.stringify(events)).not.toContain(huge);
      expect(JSON.stringify(events).length).toBeLessThan(16000);
      expect(
        events.find((event) => event.type === "request.opened" && event.requestId === "per_normal"),
      ).toBeDefined();
      expect(
        events.find(
          (event) => event.type === "user-input.requested" && event.requestId === "frm_normal",
        ),
      ).toBeDefined();
      await runtime.respondPermission(threadId, "per_normal", "accept");
      await runtime.respondForm(threadId, "frm_normal", { answer: "usable" });
      expect(reply.mock.calls[1]?.[0]).toMatchObject({ requestID: "per_normal", decision: "once" });
      expect(http.calls.some((call) => call.pathname.endsWith("/frm_normal/reply"))).toBe(true);
    });
  });
}
for (const fence of ["settings", "epoch", "quarantine"] as const) {
  it(`oversized discovery rejection cannot bypass ${fence}, and still presents unrelated pending work`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      http.autoComplete = false;
      let enabled = true;
      Object.assign(runtime.options, {
        enableLocalTools: true,
        pollIntervalMs: 100000,
        authorizeExecution: async () => {
          if (!enabled) throw new Error("disabled settings");
        },
      });
      const threadId = ThreadId.makeUnsafe(`oversized-fence-${fence}`);
      await runtime.start({
        threadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      await runtime.send({
        threadId,
        requestMessageId: MessageId.makeUnsafe(fence),
        input: "synthetic",
      });
      const owner = runtime.get(threadId);
      http.permissions.set(owner.native.id, [
        {
          id: "per_huge",
          sessionID: owner.native.id,
          action: "shell",
          resources: ["X".repeat(66000)],
        },
        { id: "per_other", sessionID: owner.native.id, action: "webfetch", resources: ["small"] },
      ]);
      const get = http.client.permission.get;
      vi.spyOn(http.client.permission, "get").mockImplementation(async (...args) => {
        const request = await get(...args);
        if (fence === "settings") enabled = false;
        if (fence === "epoch") Object.assign(owner, { epoch: owner.epoch + 1 });
        return request;
      });
      if (fence === "quarantine")
        await runtime.mutations
          .run(
            owner,
            "uncertain fixture mutation",
            async () => {
              throw new Error("unconfirmed");
            },
            async () => false,
          )
          .catch(() => {});
      const reply = vi.spyOn(http.client.permission, "reply");
      await runtime.reconcile(owner);
      expect(reply).not.toHaveBeenCalled();
      expect(
        events.some((event) => event.type === "request.resolved" && event.requestId === "per_huge"),
      ).toBe(false);
      expect(
        events.some((event) => event.type === "request.opened" && event.requestId === "per_other"),
      ).toBe(true);
      enabled = true;
    });
  });
}
it("bounded serializer accounts for JSON escapes/nesting without creating a whole oversized serialization", () => {
  expect(boundedV2ApprovalIntent({ command: "\\".repeat(40000) })).toBeUndefined();
  const intent = boundedV2ApprovalIntent({
    resources: ["exact command"],
    metadata: { arguments: { value: 'é\nquoted"' } },
  });
  expect(JSON.parse(intent!.content)).toEqual({
    resources: ["exact command"],
    metadata: { arguments: { value: 'é\nquoted"' } },
  });
  let nested: unknown = { command: "too deeply nested to inspect" };
  for (let depth = 0; depth < 100; depth++) nested = { arguments: nested };
  expect(boundedV2ApprovalIntent(nested)).toBeUndefined();
  // Uninspectable depth must still be deniable: freshness hashing must not impose a shallower failure on native rejection.
  expect(v2PermissionFingerprint(nested)).toMatch(/^[a-f0-9]{64}$/);
});

it("failed rejection publication repairs its bounded resolution without sending native denial again", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    http.autoComplete = false;
    Object.assign(runtime.options, { enableLocalTools: true, pollIntervalMs: 100000 });
    const threadId = ThreadId.makeUnsafe("oversized-publication");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await runtime.send({
      threadId,
      requestMessageId: MessageId.makeUnsafe("publication"),
      input: "synthetic",
    });
    const owner = runtime.get(threadId);
    http.permissions.set(owner.native.id, [
      {
        id: "per_publication",
        sessionID: owner.native.id,
        action: "shell",
        resources: ["X".repeat(66000)],
      },
    ]);
    const reply = vi.spyOn(http.client.permission, "reply").mockImplementation(async () => {
      http.permissions.set(owner.native.id, []);
    });
    const sink = runtime.options.emit;
    let fail = true;
    Object.assign(runtime.options, {
      emit: async (event: Parameters<typeof sink>[0]) => {
        if (fail && event.type === "request.resolved") {
          fail = false;
          throw new Error("synthetic publication failure");
        }
        await sink(event);
      },
    });
    await runtime.reconcile(owner);
    expect(owner.pendingInteractions?.has("request.resolved:per_publication")).toBe(true);
    await runtime.reconcile(owner);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(
      events.filter(
        (event) => event.type === "request.resolved" && event.requestId === "per_publication",
      ),
    ).toHaveLength(1);
    expect(owner.pendingInteractions?.has("request.resolved:per_publication")).toBe(false);
  });
});
