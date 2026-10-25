import type { FormDetail } from "@opencode/client";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { deferred } from "./Test.fixtures.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

function unsupportedForm(sessionID: string): FormDetail {
  return {
    id: "frm_unsupported",
    sessionID,
    title: "Hidden choice",
    fields: [{ key: "choice", type: "string", hidden: true }],
    state: { status: "pending" },
  };
}

it("unsupported presentation cancels once with an actionable warning, never fabricates an answer or waiting UI", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("unsupported-form");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    http.forms.set(owner.native.id, [unsupportedForm(owner.native.id)]);
    expect(await pendingV2Interactions(owner)).toEqual([]);
    expect(await pendingV2Interactions(owner)).toEqual([]);
    const cancellations = http.calls.filter((call) => call.method === "DELETE");
    expect(cancellations).toHaveLength(1);
    expect(new URLSearchParams(cancellations[0]?.search).get("message")).toContain(
      "without submitting answers",
    );
    expect(http.forms.get(owner.native.id)?.[0]?.state.status).toBe("cancelled");
    expect(http.calls.some((call) => call.pathname.endsWith("/reply"))).toBe(false);
    expect(events.filter((event) => event.type === "runtime.warning")).toHaveLength(1);
    expect(events.some((event) => event.type === "user-input.requested")).toBe(false);
  });
});

it("a form answered while cancellation waits is not cancelled and no undispatched mutation is quarantined", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("unsupported-form-stale");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    const form = unsupportedForm(owner.native.id);
    const entered = deferred<void>();
    const release = deferred<void>();
    const held = runtime.mutations.withNamespace(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const cancel = vi.spyOn(http.client.session.form, "cancel");
    const pending = owner.cancelUnsupportedForm!(form);
    const rejected = expect(pending).rejects.toThrow("changed before cancellation");
    http.forms.set(owner.native.id, [
      { ...form, state: { status: "answered", answer: { choice: "native" } } },
    ]);
    release.resolve();
    await held;
    await rejected;
    expect(cancel).not.toHaveBeenCalled();
    expect(() => runtime.mutations.assertSafe()).not.toThrow();
  });
});

it("lost cancellation acknowledgement quarantines the namespace without retrying cancellation or answering", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("unsupported-form-lost");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    http.forms.set(owner.native.id, [unsupportedForm(owner.native.id)]);
    const cancel = vi
      .spyOn(http.client.session.form, "cancel")
      .mockRejectedValue(new Error("lost acknowledgement"));
    await expect(pendingV2Interactions(owner)).rejects.toThrow("unconfirmed");
    await expect(pendingV2Interactions(owner)).rejects.toThrow("quarantined");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(http.calls.some((call) => call.pathname.endsWith("/reply"))).toBe(false);
  });
});

it("settings disable and failed warning delivery both reject cancellation before native mutation", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("unsupported-form-fence");
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    const form = unsupportedForm(owner.native.id);
    http.forms.set(owner.native.id, [form]);
    const cancel = vi.spyOn(http.client.session.form, "cancel");
    Object.assign(runtime.options, {
      authorizeExecution: async () => {
        throw new Error("disabled");
      },
    });
    await expect(owner.cancelUnsupportedForm!(form)).rejects.toThrow("disabled");
    Object.assign(runtime.options, { authorizeExecution: async () => {} });
    const sink = vi.spyOn(runtime.options, "emit").mockRejectedValue(new Error("sink failed"));
    await expect(owner.cancelUnsupportedForm!(form)).rejects.toThrow("sink failed");
    expect(cancel).not.toHaveBeenCalled();
    expect(() => runtime.mutations.assertSafe()).not.toThrow();
    sink.mockRestore();
  });
});
