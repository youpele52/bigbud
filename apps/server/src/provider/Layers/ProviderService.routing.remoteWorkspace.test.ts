import { assert } from "@effect/vitest";

import { Effect } from "effect";

import { ProviderService } from "../Services/ProviderService.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const routing = makeProviderServiceLayer();
routing.layer("ProviderServiceLive remote workspace routing", (it) => {
  it.effect.each(["cliProxy", "cursor", "devin", "claudeAgent", "copilot", "pi"] as const)(
    "starts %s with a local runtime and remote workspace",
    (providerKind) =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const adapter =
          providerKind === "claudeAgent"
            ? routing.claude
            : providerKind === "copilot"
              ? routing.copilot
              : routing[providerKind];
        const threadId = asThreadId(`thread-${providerKind}-remote-workspace`);
        const priorStarts = adapter.startSession.mock.calls.length;

        const session = yield* provider.startSession(threadId, {
          provider: providerKind,
          threadId,
          runtimeMode: "full-access",
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "ssh:devbox",
        });

        assert.equal(session.provider, providerKind);
        assert.equal(adapter.startSession.mock.calls.length, priorStarts + 1);
        const startInput = adapter.startSession.mock.calls.at(-1)?.[0];
        assert.equal(startInput?.providerRuntimeExecutionTargetId, "local");
        assert.equal(startInput?.workspaceExecutionTargetId, "ssh:devbox");
      }),
  );
});
