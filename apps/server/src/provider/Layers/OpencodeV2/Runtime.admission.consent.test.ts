import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

for (const boundary of ["ack", "SQL-result"] as const) {
  it(`initial admission ${boundary} across revoke/regrant never installs or publishes an accepted old owner`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const settings = await Effect.runPromise(
        makeTestSettings({
          providers: { opencodeV2: { enabled: true, nativeServiceTrust: "host-user-v1" } },
        }),
      );
      const consent = new V2ConsentAuthority(settings);
      const shared = new OpencodeV2Runtime(sharedV2FixtureOptions(runtime, http, consent));
      const repair = vi.spyOn(shared, "scheduleRepair").mockImplementation(() => {});
      const threadId = ThreadId.makeUnsafe(`admission-consent-${boundary}`);
      const entered = deferred<void>(),
        release = deferred<void>();
      http.autoComplete = false;
      try {
        await shared.start({
          threadId,
          cwd: directory,
          runtimeMode: "approval-required",
          modelSelection: {
            provider: "opencodeV2",
            subProviderID: "synthetic-provider",
            model: "synthetic-model",
          },
        });
        const owner = shared.get(threadId);
        const prompt = http.client.session.prompt.bind(http.client.session);
        const transition = shared.options.journal.transition.bind(shared.options.journal);
        const paused =
          boundary === "ack"
            ? vi.spyOn(http.client.session, "prompt").mockImplementation(async (...args) => {
                const value = await prompt(...args);
                entered.resolve();
                await release.promise;
                return value;
              })
            : vi.spyOn(shared.options.journal, "transition").mockImplementation((...args) =>
                transition(...args).pipe(
                  Effect.tap(() =>
                    args[1] === "accepted"
                      ? Effect.promise(async () => {
                          entered.resolve();
                          await release.promise;
                        })
                      : Effect.void,
                  ),
                ),
              );
        try {
          const pending = shared.send({
            threadId,
            requestMessageId: MessageId.makeUnsafe("original-operation"),
            input: "Synthetic admission",
          });
          const rejected = expect(pending).rejects.toThrow();
          await entered.promise;
          await Effect.runPromise(
            settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } }),
          );
          await Effect.runPromise(
            settings.updateSettings({
              providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
            }),
          );
          release.resolve();
          await rejected;
          const row = await Effect.runPromise(shared.options.journal.latestBound(threadId));
          // Already-admitted SQL may commit; it is not installed/published into the superseded owner.
          expect(row?.state).toBe(boundary === "ack" ? "dispatch-intent" : "accepted");
          expect(owner.row?.state).toBe("dispatch-intent");
          expect(events.some((event) => event.type === "turn.started")).toBe(false);
          expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
        } finally {
          release.resolve();
          paused.mockRestore();
        }
      } finally {
        repair.mockRestore();
        await shared.close();
        consent.close();
      }
    });
  });
}
