import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileServeOwnershipStore } from "./tailscaleRemoteAccess.ownership";
import { attachMobileGatewayToServe } from "./mobileGatewayServe";
import { resolveMobileGatewayEndpoint } from "./mobileGatewayEndpoint";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gateway-serve-"));
  dirs.push(dir);
  const ownership = createFileServeOwnershipStore(join(dir, "owner.json"));
  ownership.write(3773);
  let target: number | null = 3773;
  let failAfterSwitch = false;
  const run = vi.fn(async (_binary: string, args: readonly string[]) => {
    if (args[0] === "status") {
      if (failAfterSwitch && target === 4000) throw new Error("daemon unavailable");
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "desk.ts.net" },
        }),
        stderr: "",
      };
    }
    if (args[1] === "status")
      return {
        stdout: JSON.stringify({
          Web: {
            "desk.ts.net:443": {
              Handlers: target === null ? {} : { "/": { Proxy: `http://127.0.0.1:${target}` } },
            },
          },
        }),
        stderr: "",
      };
    const port = Number(args.at(-1)?.split(":").at(-1));
    target = port;
    return { stdout: "", stderr: "" };
  });
  return {
    dir,
    ownership,
    run,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    target: () => target,
    remove: () => {
      target = null;
    },
    setForeign: () => {
      target = 9000;
    },
    failAfterSwitch: () => {
      failAfterSwitch = true;
    },
  };
}
it("waits for readiness then records the new target", async () => {
  const f = await fixture();
  const result = await attachMobileGatewayToServe({ ...f, port: 4000 });
  expect(result.serving).toBe(true);
  expect(f.target()).toBe(4000);
  expect(f.ownership.read()).toBe(4000);
  expect(f.start.mock.invocationCallOrder[0]).toBeLessThan(
    f.run.mock.invocationCallOrder[
      f.run.mock.calls.findIndex(([, args]) => args.includes("--bg"))
    ]!,
  );
});
it("readiness failure leaves old target and ownership untouched", async () => {
  const f = await fixture();
  f.start.mockRejectedValue(new Error("not ready"));
  await expect(attachMobileGatewayToServe({ ...f, port: 4000 })).rejects.toThrow("not ready");
  expect(f.run.mock.calls.every(([, args]) => args.includes("--json"))).toBe(true);
  expect(f.ownership.read()).toBe(3773);
  expect(f.stop).toHaveBeenCalledOnce();
});
it("rolls back an unconfirmed applied mapping using temp-state ownership", async () => {
  const f = await fixture();
  f.failAfterSwitch();
  await expect(attachMobileGatewayToServe({ ...f, port: 4000 })).rejects.toThrow();
  expect(f.target()).toBe(3773);
  expect(f.ownership.read()).toBe(3773);
  expect(f.stop).toHaveBeenCalledOnce();
});
it("does not replace a foreign mapping even during rollback", async () => {
  const f = await fixture();
  f.setForeign();
  await expect(attachMobileGatewayToServe({ ...f, port: 4000 })).rejects.toThrow();
  expect(f.target()).toBe(9000);
  expect(f.run.mock.calls.every(([, args]) => args.includes("--json"))).toBe(true);
});
it("persists an endpoint outside generations and never rescans an established port", async () => {
  const f = await fixture();
  const select = vi.fn(async () => 4000);
  expect(await resolveMobileGatewayEndpoint(f.dir, 4000, select)).toBe(4000);
  expect(await resolveMobileGatewayEndpoint(f.dir, 5000, select)).toBe(4000);
  expect(select).toHaveBeenCalledOnce();
});

it("stale ownership with no live route neither starts a child nor recreates exposure", async () => {
  const f = await fixture();
  f.remove();
  await expect(attachMobileGatewayToServe({ ...f, port: 4000 })).rejects.toThrow(
    "no longer present",
  );
  expect(f.start).not.toHaveBeenCalled();
  expect(f.target()).toBeNull();
  expect(f.run.mock.calls.every(([, args]) => args.includes("--json"))).toBe(true);
});
it("removal during readiness cancels migration without inventing a rollback route", async () => {
  const f = await fixture();
  f.start.mockImplementation(async () => {
    f.remove();
  });
  await expect(attachMobileGatewayToServe({ ...f, port: 4000 })).rejects.toThrow(
    "no longer present",
  );
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.target()).toBeNull();
  expect(f.run.mock.calls.every(([, args]) => args.includes("--json"))).toBe(true);
});
it("external removal after an attempted switch is not undone by rollback", async () => {
  const f = await fixture();
  const run = f.run;
  const runRemoving = async (binary: string, args: readonly string[]) => {
    const result = await run(binary, args);
    if (args.includes("--bg")) {
      f.remove();
      throw new Error("removed concurrently");
    }
    return result;
  };
  await expect(
    attachMobileGatewayToServe({ ...f, run: runRemoving, port: 4000 }),
  ).rejects.toThrow();
  expect(f.target()).toBeNull();
  expect(f.ownership.read()).toBe(3773);
  expect(f.run.mock.calls.filter(([, args]) => args.includes("--bg"))).toHaveLength(1);
});
