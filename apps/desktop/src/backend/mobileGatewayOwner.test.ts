import { afterEach, expect, it, vi } from "vitest";
import {
  gatewayOwnerFixture as fixture,
  cleanupGatewayFixtures,
} from "./mobileGatewayOwner.fixtures";
vi.mock("./backendPort", () => ({ resolveDesktopBackendPort: async () => 4773 }));
vi.mock("../logging/logging", () => ({ backendChildEnv: () => ({}) }));
afterEach(async () => {
  vi.resetModules();
  await cleanupGatewayFixtures();
});
it("does not run an optional gateway without consent or binary opt-in", async () => {
  const f = await fixture(false);
  expect(await f.owner.prepareDesktopMobileGateway(f.input)).toBeNull();
  expect(await f.owner.prepareDesktopMobileGateway({ ...f.input, env: {} })).toBeNull();
  expect(f.createSupervisor).not.toHaveBeenCalled();
  expect(f.owner.desktopMobileGatewayEnvironment()).toEqual({});
});
it("shares one fresh credential with the backend only after readiness and Serve succeed", async () => {
  const f = await fixture();
  expect(await f.owner.prepareDesktopMobileGateway(f.input)).toBe(4773);
  const config = (f.createSupervisor.mock.calls[0] as unknown as [{ credential: string }])[0];
  expect(config.credential).toHaveLength(64);
  expect(f.owner.desktopMobileGatewayEnvironment()).toEqual({
    BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL: config.credential,
  });
  const { buildBackendChildEnvironment } = await import("./backendEnv");
  const environment = buildBackendChildEnvironment({
    packagedOpencodeBinDir: null,
    packagedBundledSkillsDir: null,
    packagedBundledAgentsDir: null,
    packagedWorkspaceAgentBinary: null,
    packagedDesktopSupervisorBinary: null,
    computerUseRuntimeEnv: {},
    backendNodeExecutable: "/fixture/node",
    isPackaged: false,
    backendMaxOldSpaceMb: null,
  });
  expect(environment.BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL).toBe(config.credential);
  await f.owner.ensureDesktopMobileGateway();
  expect(f.createSupervisor).toHaveBeenCalledOnce();
  await f.owner.stopDesktopMobileGatewayAndWait();
  expect(f.supervisor.stop).toHaveBeenCalledOnce();
});
it("startup failure does not install backend credentials or replace the legacy target", async () => {
  const f = await fixture();
  f.supervisor.start.mockRejectedValue(new Error("not ready"));
  await expect(f.owner.prepareDesktopMobileGateway(f.input)).rejects.toThrow();
  expect(f.input.runServe.mock.calls.every(([, args]) => args.includes("--json"))).toBe(true);
  expect(f.owner.desktopMobileGatewayEnvironment()).toEqual({});
  expect(f.input.ownership.read()).toBe(3773);
});

it("does not migrate Serve without a complete local asset bundle", async () => {
  const f = await fixture();
  await expect(
    f.owner.prepareDesktopMobileGateway({
      ...f.input,
      env: { BIGBUD_MOBILE_GATEWAY_BINARY: f.input.env.BIGBUD_MOBILE_GATEWAY_BINARY },
    }),
  ).rejects.toThrow("assets are unavailable");
  expect(f.createSupervisor).not.toHaveBeenCalled();
  expect(f.input.runServe).not.toHaveBeenCalled();
  expect(f.input.ownership.read()).toBe(3773);
});

it("boot does not recreate an externally removed route from a stale record", async () => {
  const f = await fixture();
  f.removeRoute();
  expect(await f.owner.prepareDesktopMobileGateway(f.input)).toBeNull();
  expect(f.createSupervisor).not.toHaveBeenCalled();
  expect(f.owner.desktopMobileGatewayEnvironment()).toEqual({});
  expect(f.input.runServe.mock.calls.every(([, args]) => args.includes("--json"))).toBe(true);
});

it("removal while the child starts cannot commit a credential or recreate the route", async () => {
  const f = await fixture();
  f.supervisor.start.mockImplementation(async () => {
    f.removeRoute();
  });
  await expect(f.owner.prepareDesktopMobileGateway(f.input)).rejects.toThrow("no longer present");
  expect(f.owner.desktopMobileGatewayEnvironment()).toEqual({});
  expect(f.supervisor.stop).toHaveBeenCalledOnce();
  expect(f.input.runServe.mock.calls.every(([, args]) => args.includes("--json"))).toBe(true);
});

it.each(["127.0.0.1", "0.0.0.0"])("accepts compatible backend bind %s", async (backendHost) => {
  const f = await fixture();
  expect(await f.owner.prepareDesktopMobileGateway({ ...f.input, backendHost })).toBe(4773);
});
it.each(["::1", "::", "192.168.1.20", "100.64.1.2", "localhost", ""])(
  "refuses incompatible backend bind %s before child or Serve changes",
  async (backendHost) => {
    const f = await fixture();
    await expect(f.owner.prepareDesktopMobileGateway({ ...f.input, backendHost })).rejects.toThrow(
      "bind",
    );
    expect(f.createSupervisor).not.toHaveBeenCalled();
    expect(f.input.runServe).not.toHaveBeenCalled();
    expect(f.owner.desktopMobileGatewayEnvironment()).toEqual({});
    expect(f.input.ownership.read()).toBe(3773);
  },
);

it("retains a failed candidate until its shutdown is confirmed before preparing another", async () => {
  const f = await fixture();
  f.supervisor.start.mockRejectedValue(new Error("start failed"));
  f.supervisor.stop.mockRejectedValue(new Error("exit unconfirmed"));
  await expect(f.owner.prepareDesktopMobileGateway(f.input)).rejects.toThrow("exit unconfirmed");
  await expect(f.owner.prepareDesktopMobileGateway(f.input)).rejects.toThrow("exit unconfirmed");
  expect(f.createSupervisor).toHaveBeenCalledOnce();
  expect(f.owner.desktopMobileGatewayEnvironment()).toEqual({});
  f.supervisor.stop.mockResolvedValue();
  f.supervisor.start.mockResolvedValue();
  expect(await f.owner.prepareDesktopMobileGateway(f.input)).toBe(4773);
  expect(f.createSupervisor).toHaveBeenCalledTimes(2);
});

it.each(["quitting", "quiescing"])("refuses gateway starts and retries while %s", async (state) => {
  const f = await fixture();
  if (state === "quitting") {
    const { configureMobileGatewayLifecycle } = await import("./mobileGatewayLifecycle");
    configureMobileGatewayLifecycle(() => true);
  } else {
    const { beginInstalledProcessQuiescence } = await import("./installedProcessQuiescence");
    beginInstalledProcessQuiescence();
  }
  await expect(f.owner.prepareDesktopMobileGateway(f.input)).rejects.toThrow("stopping");
  await expect(f.owner.retryDesktopMobileGateway()).rejects.toThrow("shutting down");
  await f.owner.ensureDesktopMobileGateway();
  expect(f.createSupervisor).not.toHaveBeenCalled();
  expect(f.input.runServe).not.toHaveBeenCalled();
});
