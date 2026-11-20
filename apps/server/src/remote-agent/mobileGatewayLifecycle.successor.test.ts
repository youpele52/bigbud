import {
  publicationFixture,
  publicationWiring,
} from "./mobileOptionalPublication.test-fixtures.ts";
import { afterEach, expect, it } from "vitest";
import { gatewayContext } from "./mobileGatewayLifecycle.test-fixtures.ts";
import {
  reserveMobileGatewayAttempt,
  advanceMobileGatewayAttempt,
} from "./mobileGatewayLifecycle.transitions.ts";
import { reconcileRecordedMobileGatewayExit } from "./mobileGatewayLifecycle.successor.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { memoryRegistryCommand } from "./remoteAgentInstall.mobile.fixtures.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(processStarts = new Map<number, string | undefined>(), childOwned = true) {
  const f = await publicationFixture({ processStarts });
  fixtures.push(f);
  await f.run((publisher) => publisher.publish(f.request));
  const context = gatewayContext(f),
    child = { pid: 900_001, startedAt: "start-v2:test:old-gateway" };
  let state = reserveMobileGatewayAttempt(f.read(), context, "old-attempt");
  state = advanceMobileGatewayAttempt(state, context, "old-attempt", "attempted");
  if (childOwned)
    state = advanceMobileGatewayAttempt(state, context, "old-attempt", "child-owned", child);
  state = pinRemoteAgentBuild(state, "unrelated-client", context.binding.buildId);
  f.replaceState(state);
  return { f, child, processStarts };
}
function requireJournal(f: Awaited<ReturnType<typeof publicationFixture>>) {
  const state = f.read();
  if (state.schemaVersion !== 3) throw new Error("fixture v3 absent");
  return state;
}
it("reconciles a recorded dead child only after old-controller death and preserves unrelated pins, including lost ACK", async () => {
  const { f } = await fixture();
  await f.restart(true);
  await f.run(async (publisher) => {
    const proof = await publisher.publish({ ...f.request, stageId: "successor-component-stage" });
    let lost = false;
    publicationWiring.before = async (script) => {
      if (!lost && script.includes("printf committed")) {
        lost = true;
        f.command().loseNextAck();
      }
    };
    expect(await reconcileRecordedMobileGatewayExit(proof, "old-attempt")).toEqual({
      nonce: "old-attempt",
      status: "recorded-dead-exit",
    });
    expect(lost).toBe(true);
    const after = requireJournal(f),
      attempt = after.mobile.gatewayLifecycle!.attempts[0]!;
    expect(attempt.phase).toBe("exit-confirmed");
    expect(attempt.completionEvidence?.kind).toBe("successor-recorded-child-dead");
    expect(after.pins.map((p) => p.owner)).toEqual(["unrelated-client"]);
    expect(await reconcileRecordedMobileGatewayExit(proof, "old-attempt")).toEqual({
      nonce: "old-attempt",
      status: "already-exited",
    });
    expect(f.read()).toEqual(after);
  });
});
it("refuses a live prior controller even when the recorded child is absent", async () => {
  const { f } = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.remint(f.request.stageId, 1),
      before = f.read();
    await expect(reconcileRecordedMobileGatewayExit(proof, "old-attempt")).rejects.toThrow(
      /controller.*live/,
    );
    expect(f.read()).toEqual(before);
  });
});
it.each(["live", "unknown"] as const)(
  "refuses a %s recorded child after controller death",
  async (state) => {
    const processes = new Map<number, string | undefined>();
    const { f, child } = await fixture(processes);
    processes.set(child.pid, state === "live" ? child.startedAt : undefined);
    await f.restart(true);
    await f.run(async (publisher) => {
      const proof = await publisher.publish({ ...f.request, stageId: "successor-component-stage" }),
        before = f.read();
      await expect(reconcileRecordedMobileGatewayExit(proof, "old-attempt")).rejects.toThrow(
        /child.*live/,
      );
      expect(f.read()).toEqual(before);
    });
  },
);
it.each(["missing-host", "foreign-host", "unrecorded-attempt"] as const)(
  "preserves %s as explicit repair without guessing current host",
  async (mode) => {
    const { f } = await fixture(new Map(), mode !== "unrecorded-attempt");
    const state = requireJournal(f),
      attempt = state.mobile.gatewayLifecycle!.attempts[0]!;
    const { controllerHost: _host, ...legacy } = attempt;
    f.replaceState({
      ...state,
      mobile: {
        ...state.mobile,
        gatewayLifecycle: {
          ...state.mobile.gatewayLifecycle!,
          attempts: [
            mode === "missing-host"
              ? legacy
              : mode === "foreign-host"
                ? {
                    ...attempt,
                    controllerHost: {
                      hostname: "another-host",
                      machineId: "machine-v1:another-host",
                    },
                  }
                : attempt,
          ],
        },
      },
    });
    await f.restart(true);
    await f.run(async (publisher) => {
      const proof = await publisher.publish({ ...f.request, stageId: "successor-component-stage" }),
        before = f.read();
      await expect(reconcileRecordedMobileGatewayExit(proof, "old-attempt")).rejects.toThrow(
        /repair|foreign/,
      );
      expect(f.read()).toEqual(before);
    });
  },
);
it("generic CAS cannot add/replace a recorded controller host", async () => {
  const { f } = await fixture(),
    store = makeRemoteAgentRegistryStore(f.control.root, memoryRegistryCommand(f.read()));
  await expect(
    store.update((state) => {
      if (state.schemaVersion !== 3) throw new Error("fixture v3 absent");
      const lifecycle = state.mobile.gatewayLifecycle!;
      return {
        ...state,
        revision: state.revision + 1,
        mobile: {
          ...state.mobile,
          gatewayLifecycle: {
            ...lifecycle,
            attempts: lifecycle.attempts.map((a) =>
              Object.assign({}, a, { controllerHost: { hostname: "forged", machineId: null } }),
            ),
          },
        },
      };
    }),
  ).rejects.toThrow(/identity/);
});
it("refuses an immutable attempt changed between kernel observation and CAS", async () => {
  const { f } = await fixture();
  await f.restart(true);
  await f.run(async (publisher) => {
    const proof = await publisher.publish({ ...f.request, stageId: "successor-component-stage" });
    let reads = 0;
    publicationWiring.before = async (script) => {
      if (script.includes("printf committed") || ++reads !== 2) return;
      const state = requireJournal(f),
        lifecycle = state.mobile.gatewayLifecycle!;
      f.replaceState({
        ...state,
        mobile: {
          ...state.mobile,
          gatewayLifecycle: {
            ...lifecycle,
            attempts: lifecycle.attempts.map((a) =>
              Object.assign({}, a, {
                binding: { ...a.binding, epoch: "changed-after-observation" },
              }),
            ),
          },
        },
      });
    };
    await expect(reconcileRecordedMobileGatewayExit(proof, "old-attempt")).rejects.toThrow(
      /changed during/,
    );
    expect(requireJournal(f).mobile.gatewayLifecycle?.attempts[0]?.phase).toBe("child-owned");
    expect(f.read().pins).toHaveLength(2);
  });
});

it("recognizes recorded-child PID reuse without touching the unrelated current process", async () => {
  const processes = new Map<number, string | undefined>();
  const { f, child } = await fixture(processes);
  processes.set(child.pid, "start-v2:test:unrelated-current-process");
  await f.restart(true);
  await f.run(async (publisher) => {
    const proof = await publisher.publish({ ...f.request, stageId: "successor-component-stage" });
    expect((await reconcileRecordedMobileGatewayExit(proof, "old-attempt")).status).toBe(
      "recorded-dead-exit",
    );
    expect(processes.get(child.pid)).toBe("start-v2:test:unrelated-current-process");
    expect(requireJournal(f).mobile.gatewayLifecycle?.attempts[0]?.child).toEqual(child);
  });
});
it("does not reinterpret absent PIDs with legacy unprovable start identity", async () => {
  const { f } = await fixture(),
    state = requireJournal(f),
    lifecycle = state.mobile.gatewayLifecycle!;
  f.replaceState({
    ...state,
    mobile: {
      ...state.mobile,
      gatewayLifecycle: {
        ...lifecycle,
        attempts: lifecycle.attempts.map((a) =>
          Object.assign({}, a, { child: { ...a.child!, startedAt: "pid:900001" } }),
        ),
      },
    },
  });
  await f.restart(true);
  await f.run(async (publisher) => {
    const proof = await publisher.publish({ ...f.request, stageId: "successor-component-stage" }),
      before = f.read();
    await expect(reconcileRecordedMobileGatewayExit(proof, "old-attempt")).rejects.toThrow(
      /unprovable/,
    );
    expect(f.read()).toEqual(before);
  });
});
