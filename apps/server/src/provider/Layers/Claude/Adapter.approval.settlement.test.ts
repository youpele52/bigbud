import { ApprovalRequestId } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit } from "effect";
import { makeApprovalTestHarness } from "./Adapter.approval.test.helpers.ts";
import { cancelAbandonedClaudeRequest } from "./Adapter.approval.lifecycle.ts";

describe("Claude final SDK decision settlement", () => {
  it.effect.each(["Bash", "AskUserQuestion", "elicitation"])(
    "denies %s aborted during terminal publication without granting or caching allow",
    (toolName) =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const harness = yield* makeApprovalTestHarness((event) =>
          Effect.sync(() => {
            if (event.type === "request.resolved" || event.type === "user-input.resolved")
              controller.abort();
          }),
        );
        const options = {
          signal: controller.signal,
          requestId: "late-abort",
          toolUseID: "tool-1",
          suggestions: [
            {
              type: "addRules" as const,
              behavior: "allow" as const,
              rules: [{ toolName: "Bash" }],
              destination: "session" as const,
            },
          ],
        };
        const result =
          toolName === "elicitation"
            ? harness.onElicitation({ serverName: "docs", message: "Question" }, options)
            : harness.canUseTool(toolName, {}, options);
        for (let attempt = 0; attempt < 20 && harness.events.length === 0; attempt++)
          yield* Effect.yieldNow;
        const id = ApprovalRequestId.makeUnsafe("late-abort");
        const duplicateOptions = { ...options, signal: new AbortController().signal };
        const duplicate =
          toolName === "elicitation"
            ? harness.onElicitation({ serverName: "docs", message: "Question" }, duplicateOptions)
            : harness.canUseTool(toolName, {}, duplicateOptions);
        if (toolName === "Bash")
          yield* Deferred.succeed(
            harness.context.pendingApprovals.get(id)!.decision,
            "acceptForSession",
          );
        else
          yield* Deferred.succeed(harness.context.pendingUserInputs.get(id)!.answers, {
            answer: "yes",
          });
        const final = yield* Effect.promise(async () => result);
        assert.deepEqual(yield* Effect.promise(async () => duplicate), final);
        assert.deepEqual(
          final,
          toolName === "elicitation"
            ? { action: "cancel" }
            : { behavior: "deny", message: "User cancelled tool execution." },
        );
        assert.isFalse(harness.context.appliedSessionPermissionRequests.has(id));
        const replayOptions = { ...options, signal: new AbortController().signal };
        const replay = yield* Effect.promise(async () =>
          toolName === "elicitation"
            ? harness.onElicitation({ serverName: "docs", message: "Question" }, replayOptions)
            : harness.canUseTool(toolName, {}, replayOptions),
        );
        assert.deepEqual(replay, final);
        assert.equal(
          harness.events.filter(
            (event) => event.type === "request.resolved" || event.type === "user-input.resolved",
          ).length,
          1,
        );
      }),
  );

  it.effect.each(["Bash", "AskUserQuestion", "elicitation"])(
    "keeps a single %s settlement owner when stop races a gated publication",
    (toolName) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeApprovalTestHarness((event) =>
          event.type === "request.resolved" || event.type === "user-input.resolved"
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        const options = {
          signal: new AbortController().signal,
          requestId: "stop-race",
          toolUseID: "tool-1",
          suggestions: [
            {
              type: "addRules" as const,
              behavior: "allow" as const,
              rules: [{ toolName: "Bash" }],
              destination: "session" as const,
            },
          ],
        };
        const result =
          toolName === "elicitation"
            ? harness.onElicitation({ serverName: "docs", message: "Question" }, options)
            : harness.canUseTool(toolName, {}, options);
        for (let attempt = 0; attempt < 20 && harness.events.length === 0; attempt++)
          yield* Effect.yieldNow;
        const id = ApprovalRequestId.makeUnsafe("stop-race");
        if (toolName === "Bash")
          yield* Deferred.succeed(
            harness.context.pendingApprovals.get(id)!.decision,
            "acceptForSession",
          );
        else
          yield* Deferred.succeed(harness.context.pendingUserInputs.get(id)!.answers, {
            answer: "yes",
          });
        yield* Deferred.await(started);
        const duplicateOptions = { ...options, signal: new AbortController().signal };
        const duplicate =
          toolName === "elicitation"
            ? harness.onElicitation({ serverName: "docs", message: "Question" }, duplicateOptions)
            : harness.canUseTool(toolName, {}, duplicateOptions);
        harness.context.stopped = true;
        harness.context.session = { ...harness.context.session, status: "closed" };
        // This is the same ledger cancellation operation used by stopSessionInternal.
        const stop = cancelAbandonedClaudeRequest(harness.context, id, {
          makeEventStamp: () => Effect.die("Stop must not publish a second terminal event"),
          offerRuntimeEvent: () => Effect.die("Duplicate resolution"),
        }).pipe(Effect.exit);
        const stopped = yield* stop;
        yield* Deferred.succeed(release, undefined);
        assert.isTrue(Exit.isSuccess(stopped));
        const final = yield* Effect.promise(async () => result);
        assert.deepEqual(yield* Effect.promise(async () => duplicate), final);
        assert.deepEqual(
          final,
          toolName === "elicitation"
            ? { action: "cancel" }
            : { behavior: "deny", message: "User cancelled tool execution." },
        );
        assert.isFalse(harness.context.appliedSessionPermissionRequests.has(id));
        const entry = harness.context.requestLedger.get(id);
        assert.equal(entry?.state, "resolved");
        if (entry?.state === "resolved")
          assert.deepEqual(
            toolName === "elicitation" && entry.kind === "user-input"
              ? entry.elicitationResult
              : entry.result,
            final,
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
    "isolates an aborted %s duplicate while the owner publishes its terminal event",
    (toolName) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeApprovalTestHarness((event) =>
          event.type === "request.resolved" || event.type === "user-input.resolved"
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        const options = {
          signal: new AbortController().signal,
          requestId: "duplicate-abort",
          toolUseID: "tool-1",
          suggestions: [
            {
              type: "addRules" as const,
              behavior: "allow" as const,
              rules: [{ toolName: "Bash" }],
              destination: "session" as const,
            },
          ],
        };
        const result =
          toolName === "elicitation"
            ? harness.onElicitation({ serverName: "docs", message: "Question" }, options)
            : harness.canUseTool(toolName, {}, options);
        for (let attempt = 0; attempt < 20 && harness.events.length === 0; attempt++)
          yield* Effect.yieldNow;
        const id = ApprovalRequestId.makeUnsafe(options.requestId);
        if (toolName === "Bash")
          yield* Deferred.succeed(
            harness.context.pendingApprovals.get(id)!.decision,
            "acceptForSession",
          );
        else
          yield* Deferred.succeed(harness.context.pendingUserInputs.get(id)!.answers, {
            answer: "yes",
          });
        yield* Deferred.await(started);
        const duplicateController = new AbortController();
        const duplicateOptions = { ...options, signal: duplicateController.signal };
        const duplicate =
          toolName === "elicitation"
            ? harness.onElicitation({ serverName: "docs", message: "Question" }, duplicateOptions)
            : harness.canUseTool(toolName, {}, duplicateOptions);
        duplicateController.abort();
        assert.deepEqual(
          yield* Effect.promise(async () => duplicate),
          toolName === "elicitation"
            ? { action: "cancel" }
            : { behavior: "deny", message: "User cancelled tool execution." },
        );
        assert.isFalse(harness.context.appliedSessionPermissionRequests.has(id));
        assert.equal(harness.context.requestLedger.get(id)?.state, "resolving");
        yield* Deferred.succeed(release, undefined);
        const final = yield* Effect.promise(async () => result);
        if (final === null) assert.fail("Expected an SDK decision");
        assert.equal(
          "behavior" in final ? final.behavior : final.action,
          toolName === "elicitation" ? "accept" : "allow",
        );
        assert.equal(harness.context.appliedSessionPermissionRequests.has(id), toolName === "Bash");
        assert.equal(
          harness.events.filter(
            (event) => event.type === "request.resolved" || event.type === "user-input.resolved",
          ).length,
          1,
        );
      }),
  );

  it.effect("never caches allow or grants permissions when terminal publication fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeApprovalTestHarness((event) =>
        event.type === "request.resolved"
          ? Effect.die("resolution publication failed")
          : Effect.void,
      );
      const options = {
        signal: new AbortController().signal,
        requestId: "failed-resolution",
        toolUseID: "tool-1",
        suggestions: [
          {
            type: "addRules" as const,
            behavior: "allow" as const,
            rules: [{ toolName: "Bash" }],
            destination: "session" as const,
          },
        ],
      };
      const result = harness.canUseTool("Bash", {}, options).then(
        () => "allowed",
        () => "failed",
      );
      for (let attempt = 0; attempt < 20 && harness.events.length === 0; attempt++)
        yield* Effect.yieldNow;
      const id = ApprovalRequestId.makeUnsafe(options.requestId);
      yield* Deferred.succeed(
        harness.context.pendingApprovals.get(id)!.decision,
        "acceptForSession",
      );
      assert.equal(yield* Effect.promise(() => result), "failed");
      assert.isFalse(harness.context.appliedSessionPermissionRequests.has(id));
      assert.isFalse(harness.context.pendingApprovals.has(id));
      const replay = yield* Effect.promise(() => harness.canUseTool("Bash", {}, options));
      assert.deepEqual(replay, { behavior: "deny", message: "User cancelled tool execution." });
    }),
  );
});
