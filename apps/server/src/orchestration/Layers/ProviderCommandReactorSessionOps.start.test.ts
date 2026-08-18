import { ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { startProviderSession } from "./ProviderCommandReactorSessionOps.start.ts";

describe("startProviderSession", () => {
  it("checks the deletion fence immediately before starting a provider session", async () => {
    const threadId = ThreadId.makeUnsafe("fenced-thread");
    const startSession = vi.fn(() => Effect.void);

    const effect = startProviderSession({
      services: {
        providerService: { startSession } as never,
        setThreadSession: () => Effect.void,
        assertRuntimeStartAllowed: () =>
          Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.session.start",
              detail: "Thread is being deleted.",
            }),
          ),
      },
      thread: {
        id: threadId,
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        runtimeMode: "full-access",
      } as OrchestrationThread,
      threadId,
      createdAt: "2026-08-18T00:00:00.000Z",
      provider: "codex",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      cwd: undefined,
      preserveExistingBinding: true,
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("being deleted");
    expect(startSession).not.toHaveBeenCalled();
  });
});
