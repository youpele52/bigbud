import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";
import { v2ReplyGuard } from "./Runtime.replies.ts";

const input = {
  threadId: ThreadId.makeUnsafe("consent-race"),
  runtimeMode: "approval-required" as const,
  modelSelection: {
    provider: "opencodeV2" as const,
    subProviderID: "synthetic-provider",
    model: "synthetic-model",
  },
};
const enabled = {
  providers: { opencodeV2: { enabled: true, nativeServiceTrust: "host-user-v1" as const } },
};

it("a send queued before revoke/regrant cannot use new consent and never writes a prompt intent", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory, http }) => {
    const settings = await Effect.runPromise(makeTestSettings(enabled));
    const authority = new V2ConsentAuthority(settings);
    await runtime.start({ ...input, cwd: directory });
    const owner = runtime.get(input.threadId);
    Object.assign(owner, {
      consentPermit: authority.capture(),
      sharedTransport: "/fixture/service.json",
    });
    const hold = deferred<void>();
    owner.operation = hold.promise;
    const pending = runtime.send({
      threadId: input.threadId,
      requestMessageId: MessageId.makeUnsafe("queued-before-revoke"),
      input: "never dispatch",
    });
    const rejected = expect(pending).rejects.toThrow("revision");
    await Effect.runPromise(
      settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } }),
    );
    await Effect.runPromise(settings.updateSettings(enabled));
    hold.resolve();
    await rejected;
    expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
    expect(
      await Effect.runPromise(runtime.options.journal.latestBound(input.threadId)),
    ).toBeUndefined();
    await runtime.stop(input.threadId); // Exact local release does not require new execution consent.
    authority.close();
  });
});

it("reply dispatch validator rejects revocation during awaited owner authorization, including a decline", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory }) => {
    const settings = await Effect.runPromise(makeTestSettings(enabled));
    const authority = new V2ConsentAuthority(settings);
    await runtime.start({ ...input, cwd: directory });
    const owner = runtime.get(input.threadId);
    Object.assign(owner, {
      consentPermit: authority.capture(),
      sharedTransport: "/fixture/service.json",
    });
    const hold = deferred<void>();
    const entered = deferred<void>();
    Object.assign(runtime.options, {
      authorizeExecution: async () => {
        entered.resolve();
        await hold.promise;
      },
    });
    const guard = v2ReplyGuard(runtime.options, runtime.sessions, owner);
    const pending = guard();
    const rejected = expect(pending).rejects.toThrow("revision");
    await entered.promise;
    await Effect.runPromise(
      settings.updateSettings({ providers: { opencodeV2: { enabled: false } } }),
    );
    hold.resolve();
    await rejected;
    await runtime.stop(input.threadId);
    authority.close();
  });
});

for (const race of ["consent", "epoch", "generation"] as const) {
  it(`rejects ${race} drift at the actual queued event enqueue, not only before the emitter await`, async () => {
    await withV2RuntimeFixture(async ({ runtime, directory, events }) => {
      const settings = await Effect.runPromise(makeTestSettings(enabled));
      const authority = new V2ConsentAuthority(settings);
      await runtime.start({ ...input, cwd: directory });
      const owner = runtime.get(input.threadId);
      Object.assign(owner, {
        consentPermit: authority.capture(),
        sharedTransport: "/fixture/service.json",
      });
      const hold = deferred<void>();
      const entered = deferred<void>();
      const sink = runtime.options.emit;
      vi.spyOn(runtime.options, "emit").mockImplementation(async (event, validate) => {
        entered.resolve();
        await hold.promise;
        await sink(event, validate);
      });
      const event = {
        ...runtimeEventBase(owner, `paused-${race}`),
        type: "content.delta" as const,
        payload: { streamKind: "assistant_text" as const, delta: "late", contentIndex: 0 },
      };
      const pending = runtime.emit(owner, event);
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      if (race === "consent") {
        await Effect.runPromise(
          settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } }),
        );
        await Effect.runPromise(settings.updateSettings(enabled));
      } else if (race === "epoch") Object.assign(owner, { epoch: owner.epoch + 1 });
      else owner.lease.hub.markGap();
      hold.resolve();
      await rejected;
      expect(events.some((published) => published.eventId === event.eventId)).toBe(false);
      expect(owner.emitted.has(event.eventId)).toBe(false);
      vi.restoreAllMocks();
      await runtime.stop(input.threadId);
      authority.close();
    });
  });
}
