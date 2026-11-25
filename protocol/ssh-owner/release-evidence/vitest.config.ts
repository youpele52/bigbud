import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["protocol/ssh-owner/release-evidence/preflight.test.ts"] },
});
