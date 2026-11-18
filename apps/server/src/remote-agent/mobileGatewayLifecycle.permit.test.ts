import "./mobileGatewayLifecycle.test-boundaries.ts";
import {
  publicationFixture,
  publicationWiring,
} from "./mobileOptionalPublication.test-fixtures.ts";
import { afterEach, expect, it } from "vitest";
import { fixtureLifecycle } from "./mobileGatewayLifecycle.test-fixtures.ts";
import { parseRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}
function next(script: string) {
  const encoded = script.match(
    /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 --decode > "\$next"/,
  )?.[1];
  return encoded ? parseRemoteAgentRegistry(Buffer.from(encoded, "base64").toString()) : undefined;
}
it("cancels only an original never-invoked permit and never invents PID/start or attempted time", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("cancel-original");
    const cancellation = api.cancelUnlaunched(permit!);
    expect(api.cancelUnlaunched(permit!)).toBe(cancellation);
    await cancellation;
    let callbacks = 0;
    await expect(
      api.attempt(permit!, () => {
        callbacks++;
        throw Error("must not run");
      }),
    ).rejects.toThrow(/unspent/);
    expect(callbacks).toBe(0);
    expect(f.read().pins).toEqual([]);
    const state = f.read();
    if (state.schemaVersion !== 3) throw Error("missing journal");
    expect(state.mobile.gatewayLifecycle?.attempts[0]).toMatchObject({
      phase: "exit-confirmed",
      completionEvidence: { kind: "original-permit-not-launched" },
    });
    expect(state.mobile.gatewayLifecycle?.attempts[0]?.child).toBeUndefined();
    expect(state.mobile.gatewayLifecycle?.attempts[0]?.attemptedAtUnixMs).toBeUndefined();
  });
});
it("synchronously fences cancellation racing the attempted CAS before any callback", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("cancel-race");
    let release!: () => void,
      entered!: () => void,
      held = false,
      callbacks = 0;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        entered = r;
      });
    publicationWiring.before = async (script) => {
      const state = next(script);
      if (
        !held &&
        state?.schemaVersion === 3 &&
        state.mobile.gatewayLifecycle?.attempts[0]?.phase === "attempted"
      ) {
        held = true;
        entered();
        await gate;
      }
    };
    const attempt = api
      .attempt(permit!, () => {
        callbacks++;
        throw Error("must not run");
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await ready;
    const cancellation = api.cancelUnlaunched(permit!);
    release();
    expect(await attempt).toBeInstanceOf(Error);
    await cancellation;
    expect(callbacks).toBe(0);
    expect(f.read().pins).toEqual([]);
  });
});
it("never clears a callback-invoked unknown launch even when callback threw", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("callback-unknown");
    await expect(
      api.attempt(permit!, () => {
        throw Error("unknown callback result");
      }),
    ).rejects.toThrow(/unknown callback/);
    await expect(api.cancelUnlaunched(permit!)).rejects.toThrow(/never-invoked/);
    expect(f.read().pins).toHaveLength(1);
  });
});
it("retains cancellation-only original capability after reservation ACK and reconciliation both fail", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof);
    let published = false;
    publicationWiring.before = async (script) => {
      const state = next(script);
      if (
        !published &&
        state?.schemaVersion === 3 &&
        state.mobile.gatewayLifecycle?.attempts[0]?.phase === "reserved"
      ) {
        published = true;
        f.command().loseNextAck();
      } else if (published && !script.includes("printf committed"))
        throw Error("fixture reconciliation unavailable");
    };
    await expect(api.reserve("lost-unlaunched")).rejects.toThrow(/reconciliation/);
    publicationWiring.before = undefined;
    const original = api.originalUnlaunchedPermit("lost-unlaunched");
    await expect(
      api.attempt(original, () => {
        throw Error("must not run");
      }),
    ).rejects.toThrow(/unspent/);
    await api.cancelUnlaunched(original);
    expect(f.read().pins).toEqual([]);
  });
});
