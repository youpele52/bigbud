import { afterEach, expect, it, vi } from "vitest";
import type { SystemMonitorBridge } from "./bridge";
import {
  revokeSystemMonitorAgentToken,
  rotateSystemMonitorAgentToken,
  startSystemMonitorAgentBridge,
  stopSystemMonitorAgentBridge,
} from "./agentBridge";

afterEach(() => stopSystemMonitorAgentBridge());

it("requires the current backend token and reads the existing monitor", async () => {
  const readSnapshot = vi.fn().mockResolvedValue({
    hostname: "desktop",
    osName: "Darwin",
    osVersion: "26",
    architecture: "arm64",
    sampledAtMs: Date.now(),
    epoch: 1,
    sequence: 2,
    summaryStatus: "ready",
    cpuPercent: { value: 3, status: "ready", sampledAtMs: Date.now() },
  });
  await startSystemMonitorAgentBridge({ readSnapshot } as unknown as SystemMonitorBridge);
  const first = rotateSystemMonitorAgentToken()!;
  expect((await fetch(first.endpoint)).status).toBe(404);
  const response = await fetch(first.endpoint, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  expect((await response.json()).host.hostname).toBe("desktop");
  expect(readSnapshot).toHaveBeenCalledOnce();
  const second = rotateSystemMonitorAgentToken()!;
  expect(
    (await fetch(first.endpoint, { headers: { authorization: `Bearer ${first.token}` } })).status,
  ).toBe(404);
  revokeSystemMonitorAgentToken();
  expect(
    (await fetch(second.endpoint, { headers: { authorization: `Bearer ${second.token}` } })).status,
  ).toBe(404);
});

it("does not disclose an in-flight snapshot after backend access is revoked", async () => {
  let release!: (snapshot: unknown) => void;
  const readSnapshot = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await startSystemMonitorAgentBridge({ readSnapshot } as unknown as SystemMonitorBridge);
  const access = rotateSystemMonitorAgentToken()!;
  const pending = fetch(access.endpoint, { headers: { authorization: `Bearer ${access.token}` } });
  await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
  revokeSystemMonitorAgentToken();
  release({ hostname: "secret", sampledAtMs: Date.now() });
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret");
});
