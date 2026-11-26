import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "protocol/ssh-owner/release-evidence/cutover/check.test.ts",
      "protocol/ssh-owner/release-evidence/cutover/check.roundTrip.test.ts",
    ],
  },
});
