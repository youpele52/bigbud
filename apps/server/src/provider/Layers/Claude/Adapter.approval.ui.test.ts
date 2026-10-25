import { ApprovalRequestId, type ProviderApprovalDecision } from "@bigbud/contracts";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { makeApprovalTestHarness } from "./Adapter.approval.test.helpers.ts";

describe("Claude approval producer-to-UI contract", () => {
  it.effect.each(["suppressed", "no-suggestions", "unsafe-suggestions", "available"])(
    "exposes the session choice only when safe allowances are %s",
    (mode) =>
      Effect.gen(function* () {
        // Test-only runtime boundary: keep the web module out of the server's
        // composite TypeScript project and all server production imports.
        const uiModulePath = fileURLToPath(
          new URL(
            "../../../../../web/src/components/chat/composer/pendingApprovalActions.logic.ts",
            import.meta.url,
          ),
        );
        const { getPendingApprovalActions } = yield* Effect.promise(
          () =>
            import(uiModulePath) as Promise<{
              getPendingApprovalActions: (input: {
                requestId: ApprovalRequestId;
                sessionApprovalAvailable?: boolean | undefined;
                sessionApprovalLabel?: string | undefined;
              }) => ReadonlyArray<{ decision: ProviderApprovalDecision }>;
            }>,
        );
        const harness = yield* makeApprovalTestHarness();
        const result = harness.canUseTool(
          "Bash",
          {},
          {
            requestId: "ui-contract",
            toolUseID: "tool-1",
            signal: new AbortController().signal,
            suppressAlwaysAllowRule: mode === "suppressed",
            suggestions:
              mode === "no-suggestions"
                ? []
                : mode === "unsafe-suggestions"
                  ? [{ type: "setMode", mode: "bypassPermissions", destination: "localSettings" }]
                  : [
                      {
                        type: "addRules",
                        behavior: "allow",
                        rules: [{ toolName: "Bash", ruleContent: "git status" }],
                        destination: "localSettings",
                      },
                    ],
          },
        );
        for (let attempt = 0; attempt < 20 && harness.events.length === 0; attempt++)
          yield* Effect.yieldNow;
        const opened = harness.events.find((event) => event.type === "request.opened");
        assert.equal(opened?.type, "request.opened");
        if (opened?.type !== "request.opened") return;
        assert.equal(opened.payload.sessionApprovalAvailable, mode === "available");
        const actions = getPendingApprovalActions({
          requestId: ApprovalRequestId.makeUnsafe(String(opened.requestId)),
          sessionApprovalAvailable: opened.payload.sessionApprovalAvailable,
          sessionApprovalLabel: opened.payload.sessionApprovalLabel,
        });
        assert.equal(
          actions.some((action) => action.decision === "acceptForSession"),
          mode === "available",
        );
        if (mode !== "available") assert.isUndefined(opened.payload.sessionApprovalLabel);
        const pending = harness.context.pendingApprovals.get(
          ApprovalRequestId.makeUnsafe("ui-contract"),
        );
        yield* Deferred.succeed(pending!.decision, "decline");
        yield* Effect.promise(() => result);
      }),
  );
});
