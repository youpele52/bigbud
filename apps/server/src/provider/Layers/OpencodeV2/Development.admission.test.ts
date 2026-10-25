import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("rechecks development enablement after queued session ownership without recording or dispatching denied work", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, http, directory }) => {
    let enabled = true;
    const runtime = new OpencodeV2Runtime({
      ...fixture.options,
      authorizeExecution: async () => {
        if (!enabled) throw new Error("V2 development is disabled in settings.");
      },
    });
    const threadId = ThreadId.makeUnsafe("queued-development");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    const requestMessageId = MessageId.makeUnsafe("queued-development-request");
    try {
      await runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection,
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = runtime.withSession(threadId, () => held);
      const pending = runtime.send({
        threadId,
        requestMessageId,
        input: "must not dispatch",
        modelSelection,
      });
      const rejected = expect(pending).rejects.toThrow("disabled in settings");
      enabled = false;
      release();
      await holding;
      await rejected;
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      expect(
        await Effect.runPromise(
          fixture.options.journal.find({
            namespace: "foreground",
            ownerThreadId: threadId,
            requestMessageId,
          }),
        ),
      ).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});
