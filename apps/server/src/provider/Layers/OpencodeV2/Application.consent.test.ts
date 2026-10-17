import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { runAuthorizedV2, runV2RequestContext, runV2Cleanup } from "./Client.guard.ts";
import { makeV2Client, v2Request } from "./Client.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { deferred, FixtureEvents } from "./Test.fixtures.ts";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";

const transport = "/synthetic/service.json";
const enabled = {
  providers: {
    opencodeV2: {
      enabled: true,
      serviceFile: transport,
      nativeServiceTrust: "host-user-v1" as const,
    },
  },
};
const revoke = { providers: { opencodeV2: { nativeServiceTrust: null } } };

it("accepted backend settings revoke synchronously with an empty stream; unrelated settings do not revoke and regrant cannot revive", async () => {
  const settings = await Effect.runPromise(makeTestSettings(enabled));
  const authority = new V2ConsentAuthority(settings);
  const old = authority.capture();
  await Effect.runPromise(settings.updateSettings({ greetingName: "unrelated" }));
  expect(() => old.assertCurrent()).not.toThrow();
  await Effect.runPromise(settings.updateSettings(revoke));
  expect(old.signal.aborted).toBe(true);
  expect(() => authority.capture()).toThrow("consent");
  await Effect.runPromise(settings.updateSettings(enabled));
  expect(() => old.assertCurrent()).toThrow("revision");
  const next = authority.capture();
  expect(next.revision).toBeGreaterThan(old.revision);
  next.release();
  old.release();
  authority.close();
});

it("missing synchronous settings authority fails closed and scope disposal cannot revive permits", async () => {
  const absent = new V2ConsentAuthority({});
  expect(() => absent.capture()).toThrow("consent");
  absent.close();
  const settings = await Effect.runPromise(makeTestSettings(enabled));
  const authority = new V2ConsentAuthority(settings);
  const permit = authority.capture();
  authority.close();
  expect(permit.signal.aborted).toBe(true);
  expect(() => permit.assertCurrent()).toThrow("revision");
});

it("an uninitialized older settings snapshot does not crash dormant layer creation or grant native authority", () => {
  const authority = new V2ConsentAuthority({
    currentSnapshot: (() => ({})) as NonNullable<
      ConstructorParameters<typeof V2ConsentAuthority>[0]["currentSnapshot"]
    >,
  });
  expect(() => authority.capture()).toThrow("consent");
  expect(() => authority.capture(true)).toThrow("consent");
  authority.close();
});

it("a dormant coordinator tolerates uninitialized proxy fixtures without granting consent or failing scope close", async () => {
  const coordinator = new V2ThreadToolsActivation({
    currentSnapshot: () => ({}),
    onSnapshotChange: () => ({}),
  } as unknown as ServerSettingsShape);
  expect(() => coordinator.consent.capture()).toThrow("consent");
  await expect(coordinator.close()).resolves.toBeUndefined();
});

it("a late native response after revoke/regrant is discarded and its body cancelled, without automatic retry", async () => {
  const settings = await Effect.runPromise(makeTestSettings(enabled));
  const authority = new V2ConsentAuthority(settings);
  const entered = deferred<void>();
  const hold = deferred<Response>();
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const nativeFetch = vi.fn(() => {
    entered.resolve();
    return hold.promise;
  });
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:49992",
    sharedTransport: transport,
    fetch: Object.assign(nativeFetch, { preconnect: () => {} }) as typeof fetch,
  });
  const pending = runAuthorizedV2(authority, transport, () =>
    v2Request("late.info", (signal) => client.server.info({ signal })),
  );
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  await Effect.runPromise(settings.updateSettings(revoke));
  await Effect.runPromise(settings.updateSettings(enabled));
  hold.resolve(response);
  await rejected;
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(nativeFetch).toHaveBeenCalledTimes(1);
  authority.close();
});

it("revocation during awaited registration prevents dispatch at the guarded official fetch boundary", async () => {
  const settings = await Effect.runPromise(makeTestSettings(enabled));
  const authority = new V2ConsentAuthority(settings);
  const hold = deferred<void>();
  const entered = deferred<void>();
  const nativeFetch = vi.fn(async () => new Response(JSON.stringify({ version: "2.0.26" })));
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:49992",
    sharedTransport: transport,
    beforeRequest: async () => {
      entered.resolve();
      await hold.promise;
    },
    fetch: Object.assign(nativeFetch, { preconnect: () => {} }) as typeof fetch,
  });
  const pending = runAuthorizedV2(authority, transport, () =>
    v2Request("server.info", (signal) => client.server.info({ signal })),
  );
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  await Effect.runPromise(settings.updateSettings(revoke));
  hold.resolve();
  await rejected;
  expect(nativeFetch).not.toHaveBeenCalled();
  authority.close();
});

it("catalog sequence cannot dispatch its next Location-bearing GET after revoke/regrant between reads", async () => {
  const settings = await Effect.runPromise(makeTestSettings(enabled));
  const authority = new V2ConsentAuthority(settings);
  const entered = deferred<void>();
  const hold = deferred<void>();
  const nativeFetch = vi.fn(
    async () => new Response("[]", { headers: { "content-type": "application/json" } }),
  );
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:49992",
    sharedTransport: transport,
    fetch: Object.assign(nativeFetch, { preconnect: () => {} }) as typeof fetch,
  });
  const pending = runAuthorizedV2(authority, transport, async () => {
    await v2Request("catalog models", (signal) =>
      client.model.list({ location: { directory: "/fixture/workspace" } }, { signal }),
    );
    entered.resolve();
    await hold.promise;
    return v2Request("catalog providers", (signal) =>
      client.provider.list({ location: { directory: "/fixture/workspace" } }, { signal }),
    );
  });
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  await Effect.runPromise(settings.updateSettings(revoke));
  await Effect.runPromise(settings.updateSettings(enabled));
  hold.resolve();
  await rejected;
  expect(nativeFetch).toHaveBeenCalledTimes(1);
  authority.close();
});

it("revoke during acquisition never opens lazy SSE and detaches only the late borrowed client", async () => {
  const settings = await Effect.runPromise(makeTestSettings(enabled));
  const authority = new V2ConsentAuthority(settings);
  const hold = deferred<void>();
  const entered = deferred<void>();
  const source = new FixtureEvents();
  const close = vi.fn(async () => {});
  const client = makeV2Client({ endpoint: "http://127.0.0.1:49992" });
  client.event.subscribe = (options) =>
    source.subscribe(options?.signal ?? new AbortController().signal);
  const manager = new OpencodeV2ServerManager({
    maxProcesses: 1,
    maxOwners: 1,
    maxQueuedEvents: 4,
    maxEventBytes: 4096,
    consumerTimeoutMs: 1000,
    consent: authority,
    start: async () => {
      entered.resolve();
      await hold.promise;
      return {
        ownership: "borrowed",
        client,
        isRunning: () => true,
        hasExited: () => false,
        onDeath: () => () => {},
        close,
      };
    },
  });
  const pending = runAuthorizedV2(authority, transport, () =>
    manager.acquire({
      runtimeTargetId: "local",
      sharedService: {
        registrationFile: transport,
        generation: "fixture",
        storageIdentity: "logical",
      },
    }),
  );
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  await Effect.runPromise(settings.updateSettings(revoke));
  hold.resolve();
  await rejected;
  expect(source.subscriptions).toBe(0);
  expect(close).toHaveBeenCalledTimes(1);
  await manager.close();
  authority.close();
});

it("health context excludes Location/catalog; original-owner cleanup excludes replies and prompts", async () => {
  const settings = await Effect.runPromise(
    makeTestSettings({ providers: { opencodeV2: { enabled: true } } }),
  );
  const authority = new V2ConsentAuthority(settings);
  const nativeFetch = vi.fn(async () => new Response(null, { status: 204 }));
  const client = makeV2Client({
    endpoint: "http://127.0.0.1:49992",
    sharedTransport: transport,
    fetch: Object.assign(nativeFetch, { preconnect: () => {} }) as typeof fetch,
  });
  const health = authority.capture(true);
  await expect(
    runV2RequestContext({ transport, permit: health, intent: "health" }, () =>
      client.model.list({ location: { directory: "/workspace" } }),
    ),
  ).rejects.toThrow();
  await expect(
    runV2Cleanup(transport, "owned", () =>
      client.session.prompt({ sessionID: "owned", text: "never" }),
    ),
  ).rejects.toThrow();
  await expect(
    runV2Cleanup(transport, "owned", () =>
      client.session.interrupt({ sessionID: "other", resume: false }),
    ),
  ).rejects.toThrow();
  expect(nativeFetch).not.toHaveBeenCalled();
  health.release();
  authority.close();
});
