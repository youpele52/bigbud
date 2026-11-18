import { beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({
  status: null as string | null,
  origin: null as string | null,
  prepare: vi.fn(),
}));
vi.mock("./backend/mobileGatewayOwner", () => ({
  desktopMobileGatewayPort: () => (gateway.origin ? 4773 : null),
  desktopMobileGatewayOrigin: () => gateway.origin,
  desktopMobileGatewayStatus: () => gateway.status,
  retryDesktopMobileGateway: vi.fn(),
  prepareDesktopMobileGateway: gateway.prepare,
}));
const statusMock = vi.fn();
const enableMock = vi.fn();
const disableMock = vi.fn();

vi.mock("./backend/tailscaleRemoteAccess", () => ({
  getDesktopTailscaleRemoteAccessStatus: (...args: unknown[]) => statusMock(...args),
  enableDesktopTailscaleRemoteAccess: (...args: unknown[]) => enableMock(...args),
  disableDesktopTailscaleRemoteAccess: (...args: unknown[]) => disableMock(...args),
}));

import { makeDesktopMobileRemoteAccess } from "./main.bootstrap.tailscale";

const serving = {
  installed: true,
  running: true,
  online: true,
  serving: true,
  remoteBaseUrl: "https://desk.tail1.ts.net",
  error: null,
};

describe("makeDesktopMobileRemoteAccess", () => {
  beforeEach(() => {
    gateway.status = null;
    gateway.origin = null;
    statusMock.mockReset();
    enableMock.mockReset();
    disableMock.mockReset();
  });

  it("advertises the tailnet origin only while Serve exposes this backend", async () => {
    let port = 3773;
    const access = makeDesktopMobileRemoteAccess({
      baseDir: "/tmp/x",
      getBackendPort: () => port,
      getBackendHost: () => "127.0.0.1",
    });
    access.setLocalBaseUrl("http://192.168.1.20:3773");
    expect(access.getMobileBackendBaseUrl()).toBe("http://192.168.1.20:3773");

    statusMock.mockResolvedValueOnce(serving);
    await access.getTailscaleRemoteAccessStatus();
    expect(access.getMobileBackendBaseUrl()).toBe("https://desk.tail1.ts.net");

    port = 3774;
    statusMock.mockResolvedValueOnce({ ...serving, serving: false, error: "stale" });
    await access.getTailscaleRemoteAccessStatus();
    expect(statusMock).toHaveBeenLastCalledWith(3774, undefined, expect.anything());
    expect(access.getMobileBackendBaseUrl()).toBe("http://192.168.1.20:3773");

    enableMock.mockResolvedValueOnce(serving);
    await access.enableTailscaleRemoteAccess();
    expect(access.getMobileBackendBaseUrl()).toBe("https://desk.tail1.ts.net");

    disableMock.mockResolvedValueOnce({ ...serving, serving: false });
    await access.disableTailscaleRemoteAccess();
    expect(access.getMobileBackendBaseUrl()).toBe("http://192.168.1.20:3773");
  });
});

it("keeps the gateway prototype inactive without development permission", async () => {
  statusMock.mockClear();
  vi.stubEnv("BIGBUD_MOBILE_GATEWAY_BINARY", "/fixture/gateway");
  try {
    const access = makeDesktopMobileRemoteAccess({
      baseDir: "/tmp/x",
      getBackendPort: () => 3773,
      getBackendHost: () => "127.0.0.1",
    });
    await access.prepareGateway("/fixture/settings.json", false);
    expect(statusMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(["ready", "retrying"])(
  "retains active %s gateway origin through status and disable failures",
  async (state) => {
    gateway.status = state;
    gateway.origin = serving.remoteBaseUrl;
    const access = makeDesktopMobileRemoteAccess({
      baseDir: "/tmp/x",
      getBackendPort: () => 3773,
      getBackendHost: () => "127.0.0.1",
    });
    access.setLocalBaseUrl("http://192.168.1.20:3773");
    for (const failure of [
      { installed: false, running: false, online: false, error: "CLI unavailable" },
      { installed: true, running: false, online: false, error: "daemon stopped" },
      { installed: true, running: true, online: true, error: "hostname unavailable" },
    ]) {
      const unavailable = { ...serving, ...failure, serving: false, remoteBaseUrl: null };
      statusMock.mockResolvedValue(unavailable);
      disableMock.mockResolvedValue(unavailable);
      expect((await access.getTailscaleRemoteAccessStatus()).serving).toBe(false);
      expect(access.getMobileBackendBaseUrl()).toBe(serving.remoteBaseUrl);
      expect((await access.disableTailscaleRemoteAccess()).serving).toBe(false);
      expect(access.getMobileBackendBaseUrl()).toBe(serving.remoteBaseUrl);
    }
  },
);

it("retains bootstrap preparation for backend startup and supplies the actual bind", async () => {
  const { runMobileGatewayPreparation } = await import("./backend/mobileGatewayPreparation");
  gateway.status = null;
  gateway.origin = null;
  gateway.prepare.mockReset();
  statusMock.mockReset().mockResolvedValue(serving);
  vi.stubEnv("BIGBUD_MOBILE_GATEWAY_BINARY", "/fixture/gateway");
  try {
    const access = makeDesktopMobileRemoteAccess({
      baseDir: "/tmp/x",
      getBackendPort: () => 3773,
      getBackendHost: () => "::1",
    });
    await access.prepareGateway("/fixture/settings.json", true);
    expect(gateway.prepare).not.toHaveBeenCalled();
    await runMobileGatewayPreparation();
    expect(gateway.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        backendHost: "::1",
        backendPort: 3773,
        externalOrigin: serving.remoteBaseUrl,
      }),
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
