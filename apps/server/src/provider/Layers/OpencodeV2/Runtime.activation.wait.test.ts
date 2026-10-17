import * as Effect from "effect/Effect";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it } from "vitest";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

const selection = {
  provider: "opencodeV2" as const,
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
};

it("startup setup-wait leaves binding intent absent and namespace queue available to settlement", async () => {
  await withV2RuntimeFixture(async ({ runtime: baseline, http, directory }) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const options = {
      ...sharedV2FixtureOptions(baseline, http),
      enableLocalTools: true,
      threadToolsPreflight: async () => {
        entered.resolve();
        await release.promise;
        throw new Error("V2 owned deferred setup");
      },
    };
    const runtime = new OpencodeV2Runtime(options),
      threadId = ThreadId.makeUnsafe("waiting-start");
    const pending = runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "full-access",
      modelSelection: selection,
    });
    const rejected = expect(pending).rejects.toThrow("deferred setup");
    try {
      await entered.promise;
      expect(await Effect.runPromise(options.sharedBindings!.find(threadId))).toBeUndefined();
      expect(
        http.calls.some((call) => call.method === "POST" && call.pathname === "/api/session"),
      ).toBe(false);
      await runtime.mutations.withNamespace(async () => {
        expect(runtime.mutations.busyCount()).toBe(0);
      });
      release.resolve();
      await rejected;
    } finally {
      release.resolve();
      await runtime.close();
    }
  });
});

it("new-turn setup-wait owns neither admissionInFlight nor the session queue and never journals/submits after deferral", async () => {
  await withV2RuntimeFixture(async ({ runtime: baseline, http, directory }) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    let waiting = false;
    const options = {
      ...sharedV2FixtureOptions(baseline, http),
      enableLocalTools: true,
      threadToolsPreflight: async () => {
        if (waiting) {
          entered.resolve();
          await release.promise;
          throw new Error("V2 owned deferred setup");
        }
      },
    };
    const runtime = new OpencodeV2Runtime(options),
      threadId = ThreadId.makeUnsafe("waiting-send"),
      messageId = MessageId.makeUnsafe("waiting-message");
    try {
      await runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "full-access",
        modelSelection: selection,
      });
      waiting = true;
      const pending = runtime.send({
        threadId,
        requestMessageId: messageId,
        input: "Owned fixture prompt",
      });
      const rejected = expect(pending).rejects.toThrow("deferred setup");
      await entered.promise;
      expect(runtime.get(threadId).admissionInFlight).not.toBe(true);
      await runtime.withSession(threadId, async () => {
        expect(runtime.get(threadId).row).toBeUndefined();
      });
      expect(await Effect.runPromise(options.journal.latestBound(threadId))).toBeUndefined();
      expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
      release.resolve();
      await rejected;
    } finally {
      release.resolve();
      await runtime.close();
    }
  });
});
