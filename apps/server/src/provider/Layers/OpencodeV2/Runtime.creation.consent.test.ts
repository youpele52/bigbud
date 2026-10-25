import { Effect } from "effect";
import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { deferred } from "./Test.fixtures.ts";

for (const stage of ["find", "reserve", "dispatch-intent"] as const) {
  it(`revocation during awaited shared-binding ${stage} prevents native creation and conserves durable state`, async () => {
    await withV2RuntimeFixture(async ({ runtime, directory, http }) => {
      const enabled = {
        providers: {
          opencodeV2: {
            enabled: true,
            serviceFile: "/registered/service.json",
            nativeServiceTrust: "host-user-v1" as const,
          },
        },
      };
      const settings = await Effect.runPromise(makeTestSettings(enabled));
      const authority = new V2ConsentAuthority(settings);
      const entered = deferred<void>();
      const hold = deferred<void>();
      const repo = runtime.options.sharedBindings!;
      const pause = <A, E>(effect: Effect.Effect<A, E>, operation: string) =>
        effect.pipe(
          Effect.tap(() =>
            operation === stage
              ? Effect.promise(async () => {
                  entered.resolve();
                  await hold.promise;
                })
              : Effect.void,
          ),
        );
      const options = sharedV2FixtureOptions(runtime, http, authority);
      const shared = new OpencodeV2Runtime({
        ...options,
        sharedBindings: {
          ...repo,
          find: (id) => pause(repo.find(id), "find"),
          reserve: (input) => pause(repo.reserve(input), "reserve"),
          transition: (row, next) => pause(repo.transition(row, next), next),
        },
      });
      const input = {
        threadId: ThreadId.makeUnsafe(`sql-${stage}`),
        cwd: directory,
        runtimeMode: "approval-required" as const,
        modelSelection: {
          provider: "opencodeV2" as const,
          subProviderID: "synthetic-provider",
          model: "synthetic-model",
        },
      };
      const pending = shared.start(input);
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      await Effect.runPromise(
        settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } }),
      );
      const retained = await Effect.runPromise(repo.find(input.threadId));
      await Effect.runPromise(settings.updateSettings(enabled));
      hold.resolve();
      await rejected;
      expect(
        http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
      ).toHaveLength(0);
      expect(await Effect.runPromise(repo.find(input.threadId))).toEqual(retained);
      expect(retained?.state).toBe(
        stage === "find" ? undefined : stage === "reserve" ? "reserved" : "dispatch-intent",
      );
      expect(
        await Effect.runPromise(runtime.options.journal.latestBound(input.threadId)),
      ).toBeUndefined();
      await shared.close();
      authority.close();
    });
  });
}
