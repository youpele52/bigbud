import { ApprovalRequestId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit } from "effect";
import { vi } from "vitest";
import { awaitClaudeCallback } from "./Adapter.approval.wait.ts";
import { makeApprovalTestHarness } from "./Adapter.approval.test.helpers.ts";

describe("Claude SDK callback publication races", () => {
  it.effect(
    "shares one request and applies session allowances once during overlapping deliveries",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const harness = yield* makeApprovalTestHarness((event) =>
          event.type === "request.opened" ? Deferred.await(gate) : Effect.void,
        );
        const options = {
          signal: new AbortController().signal,
          requestId: "overlap",
          toolUseID: "tool-1",
          suggestions: [
            {
              type: "addRules" as const,
              behavior: "allow" as const,
              rules: [{ toolName: "Bash", ruleContent: "git status" }],
              destination: "localSettings" as const,
            },
          ],
        };
        const first = harness.canUseTool("Bash", {}, options);
        const second = harness.canUseTool(
          "Bash",
          {},
          { ...options, signal: new AbortController().signal },
        );
        for (
          let attempt = 0;
          attempt < 20 && harness.context.pendingApprovals.size === 0;
          attempt++
        )
          yield* Effect.yieldNow;
        const pending = harness.context.pendingApprovals.get(
          ApprovalRequestId.makeUnsafe("overlap"),
        );
        assert.isDefined(pending);
        yield* Deferred.succeed(pending!.decision, "acceptForSession");
        yield* Deferred.succeed(gate, undefined);
        const results = yield* Effect.promise(() => Promise.all([first, second]));
        assert.isTrue(results.every((result) => result?.behavior === "allow"));
        const grants = results.flatMap((result) =>
          result?.behavior === "allow" ? (result.updatedPermissions ?? []) : [],
        );
        assert.equal(grants.length, 1);
        assert.equal(grants[0]?.destination, "session");
        assert.equal(harness.events.filter((event) => event.type === "request.opened").length, 1);
        assert.equal(harness.events.filter((event) => event.type === "request.resolved").length, 1);
      }),
  );

  it.effect.each(["Bash", "AskUserQuestion", "elicitation"])(
    "settles %s cancelled during opening publication",
    (toolName) =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const harness = yield* makeApprovalTestHarness((event) =>
          Effect.sync(() => {
            if (event.type === "request.opened" || event.type === "user-input.requested")
              controller.abort();
          }),
        );
        const options = {
          signal: controller.signal,
          requestId: "publish-race",
          toolUseID: "tool-1",
          agentID: "agent-1",
        };
        const result = yield* Effect.promise(async () =>
          toolName === "elicitation"
            ? harness.onElicitation(
                { serverName: "docs", message: "Question", elicitationId: "different-id" },
                options,
              )
            : harness.canUseTool(toolName, {}, options),
        );
        assert.deepEqual(
          result,
          toolName === "elicitation"
            ? { action: "cancel" }
            : { behavior: "deny", message: "User cancelled tool execution." },
        );
        assert.equal(
          harness.context.pendingApprovals.size + harness.context.pendingUserInputs.size,
          0,
        );
        assert.equal(
          harness.context.requestLedger.get(ApprovalRequestId.makeUnsafe("publish-race"))?.state,
          "resolved",
        );
        assert.equal(
          harness.events.filter(
            (event) => event.type === "request.resolved" || event.type === "user-input.resolved",
          ).length,
          1,
        );
      }),
  );

  it.effect.each(["Bash", "AskUserQuestion", "elicitation"])(
    "cleans abandoned %s state when opening publication fails",
    (toolName) =>
      Effect.gen(function* () {
        const harness = yield* makeApprovalTestHarness((event) =>
          event.type === "request.opened" || event.type === "user-input.requested"
            ? Effect.die("publication failed")
            : Effect.void,
        );
        const options = {
          signal: new AbortController().signal,
          requestId: "failed-open",
          toolUseID: "tool-1",
        };
        const result = yield* Effect.tryPromise(async () =>
          toolName === "elicitation"
            ? harness.onElicitation({ serverName: "docs", message: "Question" }, options)
            : harness.canUseTool(toolName, {}, options),
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        assert.equal(
          harness.context.pendingApprovals.size + harness.context.pendingUserInputs.size,
          0,
        );
        assert.equal(
          harness.context.requestLedger.get(ApprovalRequestId.makeUnsafe("failed-open"))?.state,
          "resolved",
        );
        assert.equal(
          harness.events.filter(
            (event) => event.type === "request.resolved" || event.type === "user-input.resolved",
          ).length,
          1,
        );
      }),
  );

  it.effect(
    "handles abortion while attaching the listener and removes it after an interrupted wait",
    () =>
      Effect.gen(function* () {
        const services = yield* Effect.services();
        const controller = new AbortController();
        const add = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
          add(...args);
          controller.abort();
        });
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        const pending = yield* Deferred.make<string>();
        assert.equal(
          yield* awaitClaudeCallback(
            controller.signal,
            Deferred.await(pending),
            "cancel",
            Effect.runForkWith(services),
          ),
          "cancel",
        );
        assert.equal(remove.mock.calls.length, 1);
        const next = new AbortController();
        const removeNext = vi.spyOn(next.signal, "removeEventListener");
        const failed = yield* awaitClaudeCallback(
          next.signal,
          Effect.die("wait failed"),
          "cancel",
          Effect.runForkWith(services),
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(failed));
        assert.equal(removeNext.mock.calls.length, 1);
      }),
  );

  it.effect("rejects pre-aborted elicitation and cancels only the duplicate delivery", () =>
    Effect.gen(function* () {
      const harness = yield* makeApprovalTestHarness();
      const aborted = new AbortController();
      aborted.abort();
      const request = { serverName: "docs", message: "Question", elicitationId: "elicitation-id" };
      assert.deepEqual(
        yield* Effect.promise(() =>
          harness.onElicitation(request, { signal: aborted.signal, requestId: "pre-aborted" }),
        ),
        { action: "cancel" },
      );
      assert.equal(harness.events.length, 0);
      const owner = new AbortController();
      const duplicate = new AbortController();
      const first = harness.onElicitation(request, {
        signal: owner.signal,
        requestId: "duplicate",
      });
      for (let attempt = 0; attempt < 20 && harness.context.pendingUserInputs.size === 0; attempt++)
        yield* Effect.yieldNow;
      const second = harness.onElicitation(request, {
        signal: duplicate.signal,
        requestId: "duplicate",
      });
      yield* Effect.yieldNow;
      duplicate.abort();
      assert.deepEqual(yield* Effect.promise(() => second), { action: "cancel" });
      const pending = harness.context.pendingUserInputs.get(
        ApprovalRequestId.makeUnsafe("duplicate"),
      );
      assert.isDefined(pending);
      yield* Deferred.succeed(pending!.answers, { answer: "yes" });
      assert.deepEqual(yield* Effect.promise(() => first), {
        action: "accept",
        content: { answer: "yes" },
      });
      assert.equal(
        harness.events.filter((event) => event.type === "user-input.resolved").length,
        1,
      );
    }),
  );
});
