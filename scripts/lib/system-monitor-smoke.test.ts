import { describe, expect, it } from "vitest";

import { smokeTestSystemMonitorBinary } from "./system-monitor-smoke.ts";

describe("staged system monitor smoke", () => {
  it("rejects a staged executable without monitor mode", async () => {
    await expect(smokeTestSystemMonitorBinary(process.execPath)).rejects.toThrow(
      /system monitor handshake failed/,
    );
  });
});
