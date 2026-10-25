import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { makeOwnedClient } from "./Client.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";

for (const body of [{}, { data: null }, { data: {} }, { data: { id: "ses_bad", location: {} } }]) {
  it(`official Promise client HTTP 200 ${JSON.stringify(body)} cannot establish missing history or authorize creation`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const bad = makeOwnedClient({
        endpoint: "http://127.0.0.1:45991",
        password: "synthetic-only",
        fetch: Object.assign(
          async () =>
            new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
          { preconnect: () => {} },
        ) as typeof fetch,
      });
      const get = vi
        .spyOn(http.client.session, "get")
        .mockImplementation((...args) => bad.session.get(...args));
      const shared = new OpencodeV2Runtime(sharedV2FixtureOptions(runtime, http));
      const threadId = ThreadId.makeUnsafe("malformed-lookup");
      try {
        await expect(
          shared.start({
            threadId,
            cwd: directory,
            runtimeMode: "approval-required",
            modelSelection: {
              provider: "opencodeV2",
              subProviderID: "synthetic-provider",
              model: "synthetic-model",
            },
          }),
        ).rejects.toThrow("session lookup unconfirmed");
        expect(http.calls.some((call) => call.method !== "GET")).toBe(false);
        const row = await Effect.runPromise(runtime.options.sharedBindings!.find(threadId));
        expect(row?.state).toBe("reserved");
      } finally {
        get.mockRestore();
        await shared.close().catch(() => {}); // Pre-fix malformed lookup can leave a quarantined mutation.
      }
    });
  });
}
