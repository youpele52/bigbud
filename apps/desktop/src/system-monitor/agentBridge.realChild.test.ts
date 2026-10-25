import * as FS from "node:fs";
import * as Path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../env/pathResolver", () => ({
  resolvePackagedDesktopSupervisorBinary: () => null,
}));

import { SystemMonitorBridge } from "./bridge";
import {
  rotateSystemMonitorAgentToken,
  startSystemMonitorAgentBridge,
  stopSystemMonitorAgentBridge,
} from "./agentBridge";

const binary = Path.resolve(process.cwd(), "../../target/debug/bigbud-desktop-supervisor");
const previous = process.env.BIGBUD_SYSTEM_MONITOR_BINARY;

afterEach(() => {
  stopSystemMonitorAgentBridge();
  if (previous === undefined) delete process.env.BIGBUD_SYSTEM_MONITOR_BINARY;
  else process.env.BIGBUD_SYSTEM_MONITOR_BINARY = previous;
});

it.skipIf(!FS.existsSync(binary))(
  "reads a current Rust snapshot through the private endpoint",
  async () => {
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = binary;
    const monitor = new SystemMonitorBridge(false);
    try {
      await startSystemMonitorAgentBridge(monitor);
      const access = rotateSystemMonitorAgentToken()!;
      const response = await fetch(access.endpoint, {
        headers: { authorization: `Bearer ${access.token}` },
        signal: AbortSignal.timeout(8_000),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        available: true,
        host: { hostname: expect.any(String), osName: expect.any(String) },
        sampledAtMs: expect.any(Number),
      });
      expect(Math.abs(Date.now() - body.sampledAtMs)).toBeLessThan(10_000);
    } finally {
      monitor.stop();
    }
  },
);
