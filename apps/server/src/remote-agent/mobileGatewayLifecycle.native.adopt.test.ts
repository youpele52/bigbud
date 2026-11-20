import { expect, it } from "vitest";
import { fixture, row } from "./mobileGatewayLifecycle.native.transitions.fixture.ts";
import {
  adoptNativeMobileGatewayAttempt,
  completeNativeMobileGatewayAttempt,
  reserveNativeMobileGatewayAttempt,
} from "./mobileGatewayLifecycle.native.transitions.ts";
import { advanceMobileGatewayAttempt } from "./mobileGatewayLifecycle.transitions.ts";
import { setRemoteAgentMobileConsent } from "./remoteAgentInstall.mobile.transitions.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { memoryRegistryCommand } from "./remoteAgentInstall.mobile.fixtures.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

const successor = { id: "successor-nonce", pid: 777, startedAt: "start-v2:linux:fixture-boot:999" };
const third = { id: "third-nonce", pid: 778, startedAt: "start-v2:linux:fixture-boot:1000" };

async function attempted() {
  const { f, context, original } = await fixture();
  const command = memoryRegistryCommand(f.read());
  const store = makeRemoteAgentRegistryStore("/tmp/native-registry", command);
  await store.update((s) => reserveNativeMobileGatewayAttempt(s, context, original));
  await store.update((s) =>
    advanceMobileGatewayAttempt(s, context, original.binding.nonce, "attempted"),
  );
  return { context, original, store };
}
const edit = (state: RemoteAgentRegistry, change: object): RemoteAgentRegistry => {
  if (state.schemaVersion !== 3 || !state.mobile.gatewayLifecycle) throw Error("No lifecycle.");
  const lifecycle = state.mobile.gatewayLifecycle;
  return {
    ...state,
    revision: state.revision + 1,
    mobile: {
      ...state.mobile,
      gatewayLifecycle: {
        ...lifecycle,
        attempts: lifecycle.attempts.map((a) => Object.assign({}, a, change)),
      },
    },
  };
};

it("records a successor as the current controller by CAS; the original stays immutable", async () => {
  const { context, original, store } = await attempted();
  const adopted = await store.update((s) =>
    adoptNativeMobileGatewayAttempt(s, context.owner, original, context.controller, successor),
  );
  expect(row(adopted).currentController).toEqual(successor);
  expect(row(adopted).controller).toEqual(context.controller);
  expect(row(adopted).phase).toBe("attempted");
  // An idempotent retry writes nothing; a stale `from` (another successor won) is refused.
  expect(
    adoptNativeMobileGatewayAttempt(
      adopted,
      context.owner,
      original,
      context.controller,
      successor,
    ),
  ).toBe(adopted);
  expect(() =>
    adoptNativeMobileGatewayAttempt(adopted, context.owner, original, context.controller, third),
  ).toThrow(/changed since/);
  // A later successor adopts from the current controller.
  const chained = await store.update((s) =>
    adoptNativeMobileGatewayAttempt(s, context.owner, original, successor, third),
  );
  expect(row(chained).currentController).toEqual(third);
  // Native exit evidence still names the immutable original controller.
  const [boot, started] = context.controller.startedAt.split(":").slice(2);
  const terminal = await store.update((s) =>
    completeNativeMobileGatewayAttempt(
      s,
      context.owner,
      original,
      {
        kind: "native-exit",
        generation: 3,
        originalChildPid: 4321,
        originalController: { pid: context.controller.pid, boot: boot!, started: started! },
      },
      Date.now(),
    ),
  );
  expect(row(terminal).phase).toBe("exit-confirmed");
  expect(row(terminal).currentController).toEqual(third);
});

it("refuses adoption without consent at the attempt's revision", async () => {
  const { context, original, store } = await attempted();
  const revoked = await store.update((s) =>
    setRemoteAgentMobileConsent(
      s,
      { owner: context.owner, expectedConsentRevision: context.consentRevision },
      false,
    ),
  );
  expect(() =>
    adoptNativeMobileGatewayAttempt(
      revoked,
      context.owner,
      original,
      context.controller,
      successor,
    ),
  ).toThrow(/consented attempted/);
});

it("journal invariants allow only an attempted native row to change its current controller", async () => {
  const { context, original, store } = await attempted();
  // The original controller is what the native guard and receipts name: never rewritten.
  await expect(store.update((s) => edit(s, { controller: successor }))).rejects.toThrow();
  const terminal = await store.update((s) =>
    completeNativeMobileGatewayAttempt(
      s,
      context.owner,
      original,
      { kind: "native-cancel" },
      Date.now(),
    ),
  );
  expect(row(terminal).phase).toBe("exit-confirmed");
  await expect(store.update((s) => edit(s, { currentController: successor }))).rejects.toThrow(
    /fence changed/,
  );
});
