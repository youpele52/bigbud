import { expect, it } from "vitest";
import { LEGACY_OPENCODE_READ_ONLY_MESSAGE } from "@bigbud/shared/providerLifecycle";
import { makeOpencodeServerManager } from "./ServerManager.ts";

it("production manager rejects explicit and implicit legacy acquire before any spawn", async () => {
  const manager = makeOpencodeServerManager();
  await expect(manager.acquire()).rejects.toThrow(LEGACY_OPENCODE_READ_ONLY_MESSAGE);
  await expect(
    manager.acquire({ provider: "opencode", binaryPath: "/do-not-launch" }),
  ).rejects.toThrow(LEGACY_OPENCODE_READ_ONLY_MESSAGE);
  await manager.closeAll();
});
