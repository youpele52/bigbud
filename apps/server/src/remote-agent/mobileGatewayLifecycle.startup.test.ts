import { gatewayChildProbeWiring } from "./mobileGatewayLifecycle.test-boundaries.ts";
import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fixtureLifecycle } from "./mobileGatewayLifecycle.test-fixtures.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [],
  children: ChildProcess[] = [];
afterEach(async () => {
  gatewayChildProbeWiring.unavailable = false;
  for (const child of children.splice(0))
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
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
function exitRecord(f: Awaited<ReturnType<typeof publicationFixture>>) {
  const state = f.read();
  if (state.schemaVersion !== 3) throw new Error("fixture v3 absent");
  return state.mobile.gatewayLifecycle!.attempts[0]!;
}
it("registers the original fast-exit handle before an unavailable process-start probe", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("fast-exit");
    gatewayChildProbeWiring.unavailable = true;
    let child!: ChildProcess, closed!: Promise<void>;
    await expect(
      api.attempt(permit!, () => {
        child = spawn(process.execPath, ["-e", "process.exit(0)"], {
          stdio: "ignore",
          env: { PATH: "/usr/bin:/bin" },
        });
        children.push(child);
        closed = new Promise((resolve) => child.once("close", () => resolve()));
        return child;
      }),
    ).rejects.toThrow(/identity is uncertain/);
    const token = api.originalChildToken(child);
    expect(exitRecord(f).phase).toBe("attempted");
    await closed;
    await api.recordObservedExit(token);
    expect(exitRecord(f).phase).toBe("exit-confirmed");
    expect(exitRecord(f).child).toBeUndefined();
    expect(exitRecord(f).completionEvidence).toEqual({
      kind: "original-handle-exit",
      pid: child.pid,
    });
    expect(f.read().pins).toEqual([]);
    expect(await api.reserve("retry-after-fast-exit")).not.toBeNull();
  });
});
it("an original but still-live identity-unknown child remains fenced until actual exit", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("unknown-live");
    gatewayChildProbeWiring.unavailable = true;
    let child!: ChildProcess, closed!: Promise<void>;
    await expect(
      api.attempt(permit!, () => {
        child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          stdio: "ignore",
          env: { PATH: "/usr/bin:/bin" },
        });
        children.push(child);
        closed = new Promise((resolve) => child.once("close", () => resolve()));
        return child;
      }),
    ).rejects.toThrow(/identity is uncertain/);
    const token = api.originalChildToken(child);
    await expect(api.recordObservedExit(token)).rejects.toThrow(/observed/);
    await expect(api.reserve("must-not-overlap")).rejects.toThrow(/uncertain/);
    child.kill();
    await closed;
    await api.recordObservedExit(token);
    expect(exitRecord(f).completionEvidence).toEqual({
      kind: "original-handle-exit",
      pid: child.pid,
    });
  });
});
it("terminalizes an actual missing-executable spawn only after the original no-PID error handle closes", async () => {
  const f = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      api = await fixtureLifecycle(f, proof),
      permit = await api.reserve("missing-executable");
    let child!: ChildProcess, closed!: Promise<void>;
    await expect(
      api.attempt(permit!, () => {
        child = spawn(join(f.home, "missing-executable"), [], {
          stdio: "ignore",
          env: { PATH: "/usr/bin:/bin" },
        });
        children.push(child);
        closed = new Promise((resolve) => child.once("close", () => resolve()));
        return child;
      }),
    ).rejects.toThrow(/identity is uncertain/);
    const token = api.originalChildToken(child);
    expect(child.pid).toBeUndefined();
    await closed;
    await api.recordObservedExit(token);
    expect(exitRecord(f).phase).toBe("exit-confirmed");
    expect(exitRecord(f).child).toBeUndefined();
    expect(exitRecord(f).completionEvidence).toEqual({ kind: "original-handle-spawn-failed" });
    expect(f.read().pins).toEqual([]);
    expect(await api.reserve("retry-after-enoent")).not.toBeNull();
  });
});
