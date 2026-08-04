import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Exit } from "effect";

import type { BrowserManagerShape } from "../../browser/Services/BrowserManager.ts";
import { getVisibleBrowserControl } from "../../browser/Services/VisibleBrowserControl.ts";
import type { ComputerUseShape } from "../../computer-use/Services/ComputerUse.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { ThreadShellRunnerShape } from "../../shell/Services/ThreadShellRunner.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";

export type RetentionRuntimeCleanupResult = "active" | "cleaned" | "failed";

export const inspectRetentionRuntimeActivity = Effect.fn("ThreadRetention.inspectRuntimeActivity")(
  function* (
    input: {
      readonly providers: ProviderServiceShape;
      readonly browser: BrowserManagerShape;
      readonly terminal: TerminalManagerShape;
      readonly computerUse?: ComputerUseShape;
      readonly shell?: ThreadShellRunnerShape;
    },
    threadId: ThreadId,
  ) {
    const visibleBrowser = getVisibleBrowserControl();
    const checks = yield* Effect.all(
      [
        input.providers
          .listSessions()
          .pipe(
            Effect.map((sessions) => sessions.some((session) => session.threadId === threadId)),
          ),
        input.browser.hasContext?.(threadId) ?? Effect.succeed(false),
        visibleBrowser?.hasThreadLease?.(threadId) ?? Effect.succeed(false),
        input.computerUse?.isActive?.(threadId) ?? Effect.succeed(false),
        input.terminal.hasActiveThread?.(threadId) ?? Effect.succeed(false),
        input.shell?.isActive?.(threadId) ?? Effect.succeed(false),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.exit);
    if (Exit.isFailure(checks)) return "failed" as const;
    return checks.value.some(Boolean) ? ("active" as const) : ("inactive" as const);
  },
);

export function makeRetryRetentionRuntimeCleanup(input: {
  readonly providers: ProviderServiceShape;
  readonly browser: BrowserManagerShape;
  readonly terminal: TerminalManagerShape;
  readonly computerUse?: ComputerUseShape;
  readonly shell?: ThreadShellRunnerShape;
}) {
  return Effect.fn("ThreadRetention.retryRuntimeCleanup")(function* (threadId: ThreadId) {
    const activity = yield* inspectRetentionRuntimeActivity(input, threadId);
    if (activity !== "inactive") return activity;

    const sessionsExit = yield* Effect.exit(input.providers.listSessions());
    if (Exit.isFailure(sessionsExit)) return "failed";
    const providerExit = yield* Effect.exit(
      sessionsExit.value.some((session) => session.threadId === threadId)
        ? input.providers.stopSession({ threadId })
        : Effect.void,
    );
    const browserExit = yield* Effect.exit(input.browser.close(threadId));
    const terminalExit = yield* Effect.exit(
      input.terminal.close({ threadId, deleteHistory: false }),
    );
    const shellExit = yield* Effect.exit(input.shell?.closeThread(threadId) ?? Effect.void);
    return Exit.isSuccess(providerExit) &&
      Exit.isSuccess(browserExit) &&
      Exit.isSuccess(terminalExit) &&
      Exit.isSuccess(shellExit)
      ? "cleaned"
      : "failed";
  });
}
