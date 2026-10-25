import { expect, it } from "vitest";
import { readV2WindowsRecoveryHost } from "./RebootRecovery.host.windows.ts";
import { assertV2RebootBoundary, assertV2RecoveryContinuation } from "./RebootRecovery.host.ts";
import { v2WindowsInspector } from "./SharedService.windows.ts";

it.skipIf(process.platform !== "win32")(
  "independent native helpers observe the same kernel boot without service or environment identity",
  async () => {
    try {
      const first = await readV2WindowsRecoveryHost();
      v2WindowsInspector.close();
      const second = await readV2WindowsRecoveryHost();
      expect(second.host).toBe(first.host);
      expect(second.bootSession).toBe(first.bootSession);
      expect(() => assertV2RecoveryContinuation(first, second)).not.toThrow();
      expect(() => assertV2RebootBoundary(first, second)).toThrow("same boot");
    } finally {
      v2WindowsInspector.close();
    }
  },
);
