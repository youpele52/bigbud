import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import { afterEach, expect, it } from "vitest";
import { gatewayContext } from "./mobileGatewayLifecycle.test-fixtures.ts";
import {
  reserveMobileGatewayAttempt,
  advanceMobileGatewayAttempt,
  mobileGatewayBuildPin,
} from "./mobileGatewayLifecycle.transitions.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { memoryRegistryCommand } from "./remoteAgentInstall.mobile.fixtures.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  await f.run((publisher) => publisher.publish(f.request));
  return f;
}
function lifecycle(state: RemoteAgentRegistry) {
  if (state.schemaVersion !== 3 || !state.mobile.gatewayLifecycle)
    throw new Error("missing lifecycle");
  return state.mobile.gatewayLifecycle;
}
it("durably fences nonce retries, controller substitution and uncertain launch overlap", async () => {
  const f = await fixture(),
    context = gatewayContext(f);
  const state = reserveMobileGatewayAttempt(f.read(), context, "first");
  expect(reserveMobileGatewayAttempt(state, context, "first")).toBe(state);
  expect(() =>
    reserveMobileGatewayAttempt(
      state,
      { ...context, controller: { ...context.controller, id: "foreign" } },
      "first",
    ),
  ).toThrow(/another/);
  expect(() => reserveMobileGatewayAttempt(state, context, "second")).toThrow(/uncertain/);
  const attempted = advanceMobileGatewayAttempt(state, context, "first", "attempted");
  expect(() => reserveMobileGatewayAttempt(attempted, context, "second")).toThrow(/uncertain/);
  expect(attempted.pins).toContainEqual({
    owner: mobileGatewayBuildPin("first"),
    buildId: context.binding.buildId,
  });
});
it("allows initial plus five retries and permanently fences the sixth retry even after time passes", async () => {
  const f = await fixture(),
    context = gatewayContext(f);
  let state = f.read();
  for (let index = 0; index < 6; index++) {
    const nonce = `attempt-${index}`,
      child = { pid: 1000 + index, startedAt: `start-v2:test:${index}` };
    state = reserveMobileGatewayAttempt(state, context, nonce);
    state = advanceMobileGatewayAttempt(state, context, nonce, "attempted");
    state = advanceMobileGatewayAttempt(state, context, nonce, "child-owned", child);
    state = advanceMobileGatewayAttempt(state, context, nonce, "exit-confirmed", child);
  }
  expect(lifecycle(state).attempts.map((a) => a.kind)).toEqual([
    "initial",
    ...Array(5).fill("crash-restart"),
  ]);
  state = reserveMobileGatewayAttempt(state, context, "seventh");
  expect(lifecycle(state).repairRequired).toBe(true);
  expect(lifecycle(state).attempts).toHaveLength(6);
  expect(reserveMobileGatewayAttempt(state, { ...context, now: 900_000 }, "later")).toBe(state);
});
it("durably records clock regression as repair without rolling its clock back", async () => {
  const f = await fixture(),
    context = gatewayContext(f);
  const reserved = reserveMobileGatewayAttempt(f.read(), context, "clock");
  const state = reserveMobileGatewayAttempt(
    reserved,
    { ...context, now: context.now - 1 },
    "clock",
  );
  expect(lifecycle(state).repairRequired).toBe(true);
  expect(lifecycle(state).lastObservedUnixMs).toBe(context.now);
});
it("lost ACK reconciles one durable intent while a mixed P4 write preserves all mobile metadata", async () => {
  const f = await fixture(),
    context = gatewayContext(f),
    command = memoryRegistryCommand(f.read());
  const store = makeRemoteAgentRegistryStore("/tmp/agent", command);
  command.loseNextAck();
  const state = await store.update((s) => reserveMobileGatewayAttempt(s, context, "lost"));
  expect(lifecycle(state).attempts).toHaveLength(1);
  await store.update((s) => pinRemoteAgentBuild(s, "another-base-client", context.binding.buildId));
  const after = await store.read();
  expect(lifecycle(after)).toEqual(lifecycle(state));
  expect(after.pins).toContainEqual({
    owner: "another-base-client",
    buildId: context.binding.buildId,
  });
});
it("generic CAS cannot delete an uncertain child's P4 pin or reset its nonce/budget ledger", async () => {
  const f = await fixture(),
    context = gatewayContext(f);
  const initial = reserveMobileGatewayAttempt(f.read(), context, "owned");
  const store = makeRemoteAgentRegistryStore("/tmp/agent", memoryRegistryCommand(initial));
  await expect(store.update((s) => ({ ...s, revision: s.revision + 1, pins: [] }))).rejects.toThrow(
    /exact.*pin/,
  );
  await expect(
    store.update((s) => {
      if (s.schemaVersion !== 3) throw new Error("missing fixture");
      return {
        ...s,
        revision: s.revision + 1,
        mobile: { ...s.mobile, gatewayLifecycle: { ...lifecycle(s), attempts: [] } },
      };
    }),
  ).rejects.toThrow(/reset/);
  expect(await store.read()).toEqual(initial);
});
it("strict v3 refuses unknown nested lifecycle metadata and receipt JSON is never launch authority", async () => {
  const f = await fixture(),
    context = gatewayContext(f);
  const state = reserveMobileGatewayAttempt(f.read(), context, "strict");
  if (state.schemaVersion !== 3) throw new Error("fixture v3 absent");
  const future = {
    ...state,
    mobile: { ...state.mobile, gatewayLifecycle: { ...lifecycle(state), future: true } },
  };
  expect(() => parseRemoteAgentRegistry(JSON.stringify(future))).toThrow();
});

it("allows slower retries outside the rolling window but fails closed at32 lifetime nonces", async () => {
  const f = await fixture(),
    base = gatewayContext(f);
  let state = f.read();
  for (let index = 0; index < 32; index++) {
    const context = { ...base, now: base.now + index * 300_001 },
      nonce = `lifetime-${index}`;
    const child = { pid: 2000 + index, startedAt: `start-v2:test:${index}` };
    state = reserveMobileGatewayAttempt(state, context, nonce);
    state = advanceMobileGatewayAttempt(state, context, nonce, "attempted");
    state = advanceMobileGatewayAttempt(state, context, nonce, "child-owned", child);
    state = advanceMobileGatewayAttempt(state, context, nonce, "exit-confirmed", child);
  }
  const full = reserveMobileGatewayAttempt(
    state,
    { ...base, now: base.now + 33 * 300_001 },
    "over-capacity",
  );
  expect(lifecycle(full).attempts).toHaveLength(32);
  expect(lifecycle(full).repairRequired).toBe(true);
});
it("an exact terminal transition removes only its domain pin and preserves another client's reference", async () => {
  const f = await fixture(),
    context = gatewayContext(f),
    nonce = "exit-pin";
  let state = pinRemoteAgentBuild(f.read(), "other-client", context.binding.buildId);
  state = reserveMobileGatewayAttempt(state, context, nonce);
  state = advanceMobileGatewayAttempt(state, context, nonce, "attempted");
  const child = { pid: 3000, startedAt: "start-v2:test:owned" };
  state = advanceMobileGatewayAttempt(state, context, nonce, "child-owned", child);
  expect(() =>
    advanceMobileGatewayAttempt(state, context, nonce, "exit-confirmed", { ...child, pid: 3001 }),
  ).toThrow(/ownership/);
  state = advanceMobileGatewayAttempt(state, context, nonce, "exit-confirmed", child);
  expect(state.pins).toEqual([{ owner: "other-client", buildId: context.binding.buildId }]);
});
