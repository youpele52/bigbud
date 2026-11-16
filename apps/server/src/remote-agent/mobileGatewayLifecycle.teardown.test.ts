import "./mobileGatewayLifecycle.test-boundaries.ts";
import {
  publicationFixture,
  publicationWiring,
} from "./mobileOptionalPublication.test-fixtures.ts";
import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureLifecycle } from "./mobileGatewayLifecycle.test-fixtures.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { setRemoteAgentMobileConsent } from "./remoteAgentInstall.mobile.transitions.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { parseRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { revalidateMobileOptionalPublication } from "./mobileOptionalPublication.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [],
  children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}
function launch() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    env: { PATH: "/usr/bin:/bin" },
  });
  children.push(child);
  return child;
}
async function stop(child: ChildProcess) {
  const closed = once(child, "close");
  child.kill();
  await closed;
}
function next(script: string) {
  const encoded = script.match(
    /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 --decode > "\$next"/,
  )?.[1];
  return encoded ? parseRemoteAgentRegistry(Buffer.from(encoded, "base64").toString()) : undefined;
}
it("revokes both consent gates, completes only the owned exit, preserves other pins and permits later reenable", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("revoke-child");
    expect(() => api.originalChildToken(new ChildProcess())).toThrow(/Original child/);
    let child!: ChildProcess;
    const token = await api.attempt(permit!, () => {
      child = launch();
      return child;
    });
    const store = makeRemoteAgentRegistryStore(f.control.root, f.command());
    await store.update((state) => pinRemoteAgentBuild(state, "unrelated-client", state.current!));
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }));
    await store.update((state) =>
      setRemoteAgentMobileConsent(state, { owner: f.pin, expectedConsentRevision: 1 }, false),
    );
    await expect(api.reserve("forbidden-revoked")).rejects.toThrow();
    await stop(child);
    const completion = api.recordObservedExit(token);
    expect(api.recordObservedExit(token)).toBe(completion);
    await completion;
    expect(f.read().pins.map((p) => p.owner)).toEqual(["unrelated-client"]);
    const state = f.read();
    expect(state.schemaVersion === 3 && state.mobile.gatewayLifecycle?.attempts[0]?.phase).toBe(
      "exit-confirmed",
    );
    await store.update((before) =>
      setRemoteAgentMobileConsent(before, { owner: f.pin, expectedConsentRevision: 2 }, true),
    );
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: true } }));
    await expect(api.reserve("old-retired-proof")).rejects.toThrow();
  });
  await f.run(async (publisher) => {
    const proof = await publisher.publish({
      ...f.request,
      stageId: "reenabled-stage",
      consentRevision: 3,
    });
    const api = await fixtureLifecycle(f, proof);
    expect(await api.reserve("reenabled-owner")).not.toBeNull();
  });
});
it("queues exact observed exit before child identity CAS completes, even after revocation aborts that CAS", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("identity-race");
    let release!: () => void,
      entered!: () => void,
      paused = false,
      child!: ChildProcess;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    publicationWiring.before = async (script) => {
      const state = next(script);
      if (
        !paused &&
        state?.schemaVersion === 3 &&
        state.mobile.gatewayLifecycle?.attempts[0]?.phase === "child-owned"
      ) {
        paused = true;
        entered();
        await gate;
      }
    };
    const attempted = api
      .attempt(permit!, () => {
        child = launch();
        return child;
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await ready;
    await stop(child);
    const token = api.originalChildToken(child),
      completion = api.recordObservedExit(token);
    expect(api.recordObservedExit(token)).toBe(completion);
    await Effect.runPromise(f.settings.updateSettings({ mobileRemoteControl: { enabled: false } }));
    const store = makeRemoteAgentRegistryStore(f.control.root, f.command());
    await store.update((state) =>
      setRemoteAgentMobileConsent(state, { owner: f.pin, expectedConsentRevision: 1 }, false),
    );
    release();
    expect(await attempted).toBeInstanceOf(Error);
    await completion;
    const state = f.read();
    expect(state.schemaVersion === 3 && state.mobile.gatewayLifecycle?.attempts[0]?.phase).toBe(
      "exit-confirmed",
    );
    expect(f.read().pins).toEqual([]);
  });
});
it("completes exact owned exit despite stale artifact proof and canonical base selection change", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("stale-context");
    let child!: ChildProcess;
    const token = await api.attempt(permit!, () => {
      child = launch();
      return child;
    });
    const paths = await revalidateMobileOptionalPublication(proof);
    await fs.chmod(paths.assetsArchivePath, 0o644);
    const state = f.read();
    f.replaceState({ ...state, current: null });
    await expect(revalidateMobileOptionalPublication(proof)).rejects.toThrow();
    await stop(child);
    await api.recordObservedExit(token);
    const terminal = f.read();
    expect(
      terminal.schemaVersion === 3 && terminal.mobile.gatewayLifecycle?.attempts[0]?.phase,
    ).toBe("exit-confirmed");
    expect(terminal.pins).toEqual([]);
  });
});
it("settles callback finally teardown under interrupted lifetime before releasing backend ownership", async () => {
  const f = await fixture(),
    controller = new AbortController();
  let ready!: () => void,
    released = false,
    completed = false;
  const running = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const operation = f
    .run(
      async (publisher, signal) => {
        const proof = await publisher.publish(f.request),
          api = await fixtureLifecycle(f, proof),
          permit = await api.reserve("scope-finally");
        let child!: ChildProcess;
        const token = await api.attempt(permit!, () => {
          child = launch();
          return child;
        });
        ready();
        try {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        } finally {
          await f.owner().assertHeld();
          await stop(child);
          await api.recordObservedExit(token);
          completed = true;
        }
      },
      {
        signal: controller.signal,
        onExit: async () => {
          expect(completed).toBe(true);
          released = true;
        },
      },
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  await running;
  controller.abort();
  await operation;
  expect(released).toBe(true);
  expect(completed).toBe(true);
  expect(f.read().pins).toEqual([]);
});

it("late original-child completion cannot mutate a released or successor publisher scope", async () => {
  const f = await fixture();
  let child!: ChildProcess;
  const retained = await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("late-exit");
    const token = await api.attempt(permit!, () => {
      child = launch();
      return child;
    });
    return { api, token };
  });
  await stop(child);
  const before = f.read();
  await expect(retained.api.recordObservedExit(retained.token)).rejects.toThrow(/lease/);
  expect(f.read()).toEqual(before);
  await f.run(async () => {
    await expect(retained.api.recordObservedExit(retained.token)).rejects.toThrow(/lease/);
    expect(f.read()).toEqual(before);
  });
});

it("can retire the exact dead child on a regressed clock while keeping launch repair sticky", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("regressed-exit");
    let child!: ChildProcess;
    const token = await api.attempt(permit!, () => {
      child = launch();
      return child;
    });
    const before = f.read();
    if (before.schemaVersion !== 3) throw new Error("fixture v3 absent");
    const clock = before.mobile.gatewayLifecycle!.lastObservedUnixMs;
    await stop(child);
    vi.spyOn(Date, "now").mockReturnValue(0);
    await api.recordObservedExit(token);
    const state = f.read();
    if (state.schemaVersion !== 3) throw new Error("fixture v3 absent");
    expect(state.mobile.gatewayLifecycle?.repairRequired).toBe(true);
    expect(state.mobile.gatewayLifecycle?.lastObservedUnixMs).toBe(clock);
    expect(state.mobile.gatewayLifecycle?.attempts[0]?.phase).toBe("exit-confirmed");
    expect(state.pins).toEqual([]);
    await expect(api.reserve("must-not-reset")).rejects.toThrow(/repair/);
  });
});
