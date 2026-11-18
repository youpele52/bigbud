import "./mobileGatewayLifecycle.test-boundaries.ts";
import {
  publicationFixture,
  publicationWiring,
} from "./mobileOptionalPublication.test-fixtures.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { fixtureLifecycle } from "./mobileGatewayLifecycle.test-fixtures.ts";
import { mobileGatewayBuildPin } from "./mobileGatewayLifecycle.transitions.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "close");
    }
  }
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  return f;
}
it("joins one nonce, reconciles lost ACK once and never remints launch authority", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
    let held = false,
      lost = false;
    publicationWiring.before = async (script) => {
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      if (!lost && script.includes("printf committed")) {
        lost = true;
        f.command().loseNextAck();
      }
    };
    const first = api.reserve("nonce-one");
    expect(api.reserve("nonce-one")).toBe(first);
    await paused;
    release();
    const permit = await first;
    expect(permit).not.toBeNull();
    expect(lost).toBe(true);
    expect(await api.reserve("nonce-one")).toBeNull();
    let calls = 0;
    await expect(
      api.attempt({ ...permit! }, () => {
        calls++;
        throw new Error("should not run");
      }),
    ).rejects.toThrow(/Original/);
    await expect(
      api.attempt(permit!, () => {
        calls++;
        throw new Error("fixture spawn failed");
      }),
    ).rejects.toThrow(/spawn failed/);
    await expect(
      api.attempt(permit!, () => {
        calls++;
        throw new Error("duplicate");
      }),
    ).rejects.toThrow(/unspent/);
    expect(calls).toBe(1);
    await expect(api.reserve("another-nonce")).rejects.toThrow(/uncertain/);
  });
});
it("only an original observed child exit retires its own existing base pin", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof);
    const permit = await api.reserve("node-fixture-child");
    let child!: ChildProcess;
    const owned = await api.attempt(permit!, () => {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      });
      children.push(child);
      return child;
    });
    await expect(api.recordObservedExit(owned)).rejects.toThrow(/observed/);
    await expect(api.recordObservedExit({ ...owned })).rejects.toThrow(/original/);
    const state = f.read();
    expect(state.pins.some((p) => p.owner === mobileGatewayBuildPin("node-fixture-child"))).toBe(
      true,
    );
    const closed = once(child, "close");
    child.kill();
    await closed;
    await api.recordObservedExit(owned);
    expect(f.read().pins.some((p) => p.owner === mobileGatewayBuildPin("node-fixture-child"))).toBe(
      false,
    );
    const after = f.read();
    expect(after.schemaVersion === 3 && after.mobile.gatewayLifecycle?.attempts[0]?.phase).toBe(
      "exit-confirmed",
    );
  });
});
it("persists clock-regression repair and cannot reset it through a later nonce", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof);
    const time = vi.spyOn(Date, "now").mockReturnValue(100_000);
    await api.reserve("clock-first");
    time.mockReturnValue(99_999);
    await expect(api.reserve("clock-first")).rejects.toThrow(/repair/);
    const state = f.read();
    expect(state.schemaVersion === 3 && state.mobile.gatewayLifecycle?.repairRequired).toBe(true);
    time.mockReturnValue(900_000);
    await expect(api.reserve("after-clock")).rejects.toThrow(/repair/);
  });
});
it("a copied publication object cannot mint a lifecycle launch permit", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, { ...proof });
    await expect(api.reserve("copied-proof")).rejects.toThrow(/opaque/);
    const state = f.read();
    expect(state.schemaVersion === 3 && state.mobile.gatewayLifecycle).toBeUndefined();
  });
});
