import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

for (const type of ["permission", "denial", "form"] as const)
  for (const change of ["stop", "disable", "block"] as const)
    it(`queued ${type} rechecks ${change} after another startup releases namespace`, async () => {
      await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
        Object.assign(runtime.options, { enableLocalTools: true });
        const threadId = ThreadId.makeUnsafe("reply-owner");
        const modelSelection = {
          provider: "opencodeV2",
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        } as const;
        await runtime.start({
          threadId,
          cwd: directory,
          runtimeMode: "approval-required",
          modelSelection,
        });
        const owner = runtime.get(threadId);
        let enabled = true;
        Object.assign(runtime.options, {
          authorizeExecution: async () => {
            if (!enabled) throw new Error("disabled");
          },
        });
        vi.spyOn(http.client.permission, "get").mockResolvedValue({
          id: "per_queued",
          sessionID: owner.native.id,
          action: "webfetch",
          resources: ["https://example.invalid"],
        });
        vi.spyOn(http.client.session.form, "get").mockResolvedValue({
          id: "form_queued",
          sessionID: owner.native.id,
          state: { status: "pending" },
          fields: [],
        } as never);
        const permission = vi.spyOn(http.client.permission, "reply").mockResolvedValue(undefined);
        const form = vi.spyOn(http.client.session.form, "reply").mockResolvedValue(undefined);
        const entered = deferred<void>();
        const release = deferred<void>();
        const original = http.client.session.list.bind(http.client.session);
        vi.spyOn(http.client.session, "list").mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return original(...args);
        });
        const starting = runtime.start({
          threadId: ThreadId.makeUnsafe("queue-holder"),
          cwd: directory,
          runtimeMode: "approval-required",
          modelSelection,
        });
        await entered.promise;
        const pending =
          type === "form"
            ? runtime.respondForm(threadId, "form_queued", {})
            : runtime.respondPermission(
                threadId,
                "per_queued",
                type === "denial" ? "decline" : "accept",
              );
        const rejected = expect(pending).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 10));
        const stopping = change === "stop" ? runtime.stop(threadId) : undefined;
        if (change === "disable") enabled = false;
        if (change === "block") owner.executionBlocked = "blocked";
        release.resolve();
        await Promise.allSettled([starting, stopping]);
        await rejected;
        expect(permission).not.toHaveBeenCalled();
        expect(form).not.toHaveBeenCalled();
        expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
      });
    });
