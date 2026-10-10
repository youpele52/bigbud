import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import { Effect } from "effect";
import { ProviderTurnAdmissionConflict } from "../../../persistence/Services/ProviderTurnAdmissions.ts";

const threadId = ThreadId.makeUnsafe("switch-fences");
const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

for (const change of [
  "disable",
  "binary",
  "profile",
  "stop",
  "successor",
  "generation",
  "block",
  "delete",
] as const)
  it(`model switch rechecks ${change} after its second active read before native mutation`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      let config = "original";
      Object.assign(runtime.options, {
        authorizeExecution: async () => {
          if (config !== "original") throw new Error("configuration changed");
        },
      });
      await runtime.start({
        threadId,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      const owner = runtime.get(threadId);
      const entered = deferred<void>();
      const release = deferred<void>();
      const active = http.client.session.active;
      vi.spyOn(http.client.session, "active")
        .mockImplementationOnce(active)
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return active(...args);
        });
      const switching = runtime.send({
        threadId,
        modelSelection: { ...modelSelection, model: "second-model" },
        requestMessageId: MessageId.makeUnsafe(`switch-${change}`),
        input: "must not dispatch",
      });
      const rejected = expect(switching).rejects.toThrow();
      await entered.promise;
      const generation = owner.lease.generation;
      const stopping = change === "stop" ? runtime.stop(threadId) : undefined;
      if (["disable", "binary", "profile"].includes(change)) config = change;
      if (change === "successor")
        runtime.sessions.set(threadId, { ...owner, epoch: owner.epoch + 1 });
      if (change === "generation") Object.assign(owner.lease, { generation: generation + 1 });
      if (change === "block") owner.executionBlocked = "deletion fence";
      if (change === "delete")
        vi.spyOn(runtime.options.journal, "assertOwnerAvailable").mockImplementation(() =>
          Effect.fail(new ProviderTurnAdmissionConflict({ detail: "canonical deletion" })),
        );
      release.resolve();
      try {
        await rejected;
        expect(
          http.calls.filter((call) => call.pathname.endsWith("/model") && call.method === "POST"),
        ).toHaveLength(0);
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
        expect(owner.model.id).toBe("synthetic-model");
        expect(http.sessions.get(owner.native.id)?.model?.id).toBe("synthetic-model");
        expect(() => runtime.mutations.assertSafe()).not.toThrow();
      } finally {
        if (change === "successor") runtime.sessions.set(threadId, owner);
        Object.assign(owner.lease, { generation });
        await stopping;
      }
    });
  });

it("checks the exact owner synchronously at model dispatch without quarantining undispatched work", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    const runOwned = runtime.mutations.runOwned.bind(runtime.mutations);
    vi.spyOn(runtime.mutations, "runOwned").mockImplementationOnce((...args) => {
      owner.executionBlocked = "deletion began at dispatch";
      return runOwned(...args);
    });
    await expect(
      runtime.send({
        threadId,
        modelSelection: { ...modelSelection, model: "second-model" },
        requestMessageId: MessageId.makeUnsafe("dispatch-owner-fence"),
        input: "must not dispatch",
      }),
    ).rejects.toThrow();
    expect(
      http.calls.filter((call) => call.pathname.endsWith("/model") && call.method === "POST"),
    ).toHaveLength(0);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    expect(owner.model.id).toBe("synthetic-model");
    expect(() => runtime.mutations.assertSafe()).not.toThrow();
  });
});
