import * as Net from "node:net";

import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import { describe, expect, it, vi } from "vitest";

import {
  probeBackendAfterResume,
  probeBackendPort,
  resolveBackendProbeTarget,
  type BackendPortProbeResult,
} from "./backendResumeProbe";

function deps(
  result: BackendPortProbeResult,
  state: DesktopBackendStartupState = { generation: 2, startedAt: 0, status: "ready" },
) {
  return {
    getWsUrl: () => "ws://127.0.0.1:3773/?token=secret",
    getStartupState: vi.fn(() => state),
    getIsQuitting: () => false,
    probe: vi.fn(async () => result),
    republish: vi.fn(),
    restart: vi.fn(),
    log: vi.fn(),
  };
}

describe("backend resume probe", () => {
  it("republishes ready when the backend still listens", async () => {
    const d = deps("listening");
    await probeBackendAfterResume(d);
    expect(d.probe).toHaveBeenCalledWith("127.0.0.1", 3773);
    expect(d.republish).toHaveBeenCalledOnce();
    expect(d.restart).not.toHaveBeenCalled();
  });

  it("restarts a backend whose port refuses connections", async () => {
    const d = deps("refused");
    await probeBackendAfterResume(d);
    expect(d.restart).toHaveBeenCalledOnce();
    expect(d.republish).not.toHaveBeenCalled();
  });

  it("leaves an inconclusive probe alone", async () => {
    const d = deps("inconclusive");
    await probeBackendAfterResume(d);
    expect(d.restart).not.toHaveBeenCalled();
    expect(d.republish).not.toHaveBeenCalled();
  });

  it("skips startup states and ignores results from an older generation", async () => {
    const starting = deps("refused", { generation: 2, startedAt: 0, status: "upgrading" });
    await probeBackendAfterResume(starting);
    expect(starting.probe).not.toHaveBeenCalled();

    const raced = deps("refused");
    raced.getStartupState
      .mockReturnValueOnce({ generation: 2, startedAt: 0, status: "ready" })
      .mockReturnValueOnce({ generation: 3, startedAt: 0, status: "starting" });
    await probeBackendAfterResume(raced);
    expect(raced.restart).not.toHaveBeenCalled();
  });

  it("targets the renderer's own host, including IPv6 literals", () => {
    expect(resolveBackendProbeTarget("ws://[::1]:4000/?token=x")).toEqual({
      host: "::1",
      port: 4000,
    });
    expect(resolveBackendProbeTarget("not a url")).toBeNull();
    expect(resolveBackendProbeTarget("ws://localhost/")).toBeNull();
  });

  it("reports listening and refused ports over real TCP", async () => {
    const server = Net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as Net.AddressInfo;
    await expect(probeBackendPort("127.0.0.1", port)).resolves.toBe("listening");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(probeBackendPort("127.0.0.1", port)).resolves.toBe("refused");
  });
});
