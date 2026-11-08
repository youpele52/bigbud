import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { smokeTestThreadOrganizationBinary } from "./thread-organization-smoke.ts";
const binary = resolve(
  import.meta.dirname,
  "../../target/debug/bigbud-desktop-supervisor" + (process.platform === "win32" ? ".exe" : ""),
);
test.skipIf(!existsSync(binary))(
  "packaged organiser mode activates, schedules and exits",
  async () => {
    await expect(smokeTestThreadOrganizationBinary(binary)).resolves.toBeUndefined();
  },
);
test("missing artifact fails closed without retaining a native child", async () => {
  await expect(smokeTestThreadOrganizationBinary(binary + ".missing")).rejects.toThrow();
});
