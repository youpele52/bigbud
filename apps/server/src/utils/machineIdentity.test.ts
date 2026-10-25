import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { machineIdentity, parseIoregPlatformUuid } from "./machineIdentity.ts";

describe("machineIdentity", () => {
  it("is stable across calls and across processes, and never exposes the raw platform id", () => {
    const first = machineIdentity();
    expect(machineIdentity()).toBe(first);
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(first).toMatch(/^machine-v1:[0-9a-f]{64}$/);
    }
    const helper = fileURLToPath(new URL("./machineIdentity.ts", import.meta.url));
    const other = execFileSync(
      "bun",
      [
        "-e",
        `import { machineIdentity } from ${JSON.stringify(helper)}; console.log(JSON.stringify(machineIdentity()));`,
      ],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" } },
    );
    expect(JSON.parse(other.trim())).toBe(first);
  });

  it("parses the IOPlatformUUID from ioreg output", () => {
    const output = [
      "+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000213, registered>",
      "    {",
      '      "IOPlatformSerialNumber" = "SERIAL"',
      '      "IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"',
      "    }",
    ].join("\n");
    expect(parseIoregPlatformUuid(output)).toBe("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9");
    expect(parseIoregPlatformUuid('"IOPlatformUUID" = ""')).toBeUndefined();
    expect(parseIoregPlatformUuid("")).toBeUndefined();
  });
});
