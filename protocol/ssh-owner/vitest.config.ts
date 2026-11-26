import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "protocol/ssh-owner/v1.golden.test.ts",
      "protocol/ssh-owner/v1.golden.verbs.test.ts",
      "protocol/ssh-owner/v1.golden.grants.test.ts",
    ],
  },
});
