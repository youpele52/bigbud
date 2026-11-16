import "./mobileGatewayLifecycle.test-boundaries.ts";
import { vi } from "vitest";

// Controlled pipe tests use one comparable controller. Real Linux proof reads actual /proc.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      if (args[0] === `/proc/${process.pid}/stat`)
        return `${process.pid} (node) ${["S", ...Array<string>(18).fill("0"), "123"].join(" ")}`;
      if (args[0] === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
      return original.readFile(...args);
    },
  };
});
