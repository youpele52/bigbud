import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { setVisibleBrowserControl } from "../../browser/Services/VisibleBrowserControl.ts";
import { makeRetryRetentionRuntimeCleanup } from "./ThreadRetention.cleanup.ts";

const threadId = ThreadId.makeUnsafe("retention-runtime-guard");

it.effect("skips retention cleanup without stopping any active runtime", () =>
  Effect.gen(function* () {
    const runtimeKinds = ["provider", "headless", "visible", "computer", "terminal", "shell"];
    for (const activeKind of runtimeKinds) {
      const stopped: Array<string> = [];
      if (activeKind === "visible") {
        setVisibleBrowserControl({
          hasThreadLease: () => Effect.succeed(true),
        } as never);
      }
      const cleanup = makeRetryRetentionRuntimeCleanup({
        providers: {
          listSessions: () => Effect.succeed(activeKind === "provider" ? [{ threadId }] : []),
          stopSession: () => Effect.sync(() => stopped.push("provider")),
        } as never,
        browser: {
          hasContext: () => Effect.succeed(activeKind === "headless"),
          close: () => Effect.sync(() => stopped.push("browser")),
        } as never,
        terminal: {
          hasActiveThread: () => Effect.succeed(activeKind === "terminal"),
          close: () => Effect.sync(() => stopped.push("terminal")),
        } as never,
        computerUse: {
          isActive: () => Effect.succeed(activeKind === "computer"),
        } as never,
        shell: {
          isActive: () => Effect.succeed(activeKind === "shell"),
          closeThread: () => Effect.sync(() => stopped.push("shell")),
        } as never,
      });

      assert.equal(yield* cleanup(threadId), "active");
      assert.deepEqual(stopped, []);
      setVisibleBrowserControl(null);
    }
  }).pipe(Effect.ensuring(Effect.sync(() => setVisibleBrowserControl(null)))),
);
