import { expect, it, vi } from "vitest";
import { makeV2Client } from "./Client.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { callV2ThreadRpc } from "./Client.guard.orchestration.ts";
import { V2EnrollmentControls } from "./Orchestration.enrollment.controls.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

it.each(["response", "rejection"] as const)(
  "a non-cooperative SDK renewal retains physical ownership beyond RPC and join deadlines until %s",
  async (outcome) => {
    vi.useFakeTimers();
    const f = await makeV2ActivationJobsFixture(),
      app = await makeV2ThreadPluginFixture(),
      permit = f.consent.capture(),
      controls = new V2EnrollmentControls(),
      physical = deferred<Response | Error>(),
      entered = deferred<AbortSignal>(),
      transport = "/fixture/non-cooperative-transport";
    const fetch = Object.assign(
      vi.fn(async (_request: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        entered.resolve(init!.signal!);
        const result = await physical.promise;
        if (result instanceof Error) throw result;
        return result;
      }),
      { preconnect: () => {} },
    ) as unknown as typeof globalThis.fetch;
    const client = makeV2Client({
      endpoint: "http://127.0.0.1:45991",
      sharedTransport: transport,
      fetch,
    });
    const owner = app.bind("owned-renewal-session", "/fixture/renewal-location"),
      envelope = app.envelope("renew", 2, Date.now() + 55000);
    try {
      const pending = runV2RequestContext({ permit, transport, intent: "execute" }, () =>
        callV2ThreadRpc(
          client,
          owner.directory,
          "renew",
          envelope,
          owner.nativeSessionId,
          (operation) => controls.observe(operation),
        ),
      );
      const rejected = expect(pending).rejects.toThrow("timed out; admission may be unconfirmed");
      const sdkSignal = await entered.promise;
      expect(controls.count()).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(sdkSignal.aborted).toBe(true);
      expect(controls.count()).toBe(1);
      const joinDeadline = new AbortController(),
        join = controls.join(joinDeadline.signal),
        joinRejected = expect(join).rejects.toThrow("physical control remains owned");
      const timer = setTimeout(() => joinDeadline.abort(), 15000);
      await vi.advanceTimersByTimeAsync(15000);
      await joinRejected;
      clearTimeout(timer);
      expect(controls.count()).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(permit.signal.aborted).toBe(false);
      if (outcome === "response") {
        physical.resolve(
          new Response(
            JSON.stringify({
              output: {
                state: "active",
                ownerDigest: envelope.ownerDigest,
                enrollmentNonce: owner.enrollmentNonce,
                revision: 2,
                expiry: envelope.leaseExpiresAt,
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      } else physical.resolve(new Error("synthetic physical failure"));
      await controls.join(new AbortController().signal);
      expect(controls.count()).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      physical.resolve(new Response("{}"));
      await controls.join(new AbortController().signal);
      permit.release();
      f.consent.close();
      await app.close();
      vi.useRealTimers();
    }
  },
);
