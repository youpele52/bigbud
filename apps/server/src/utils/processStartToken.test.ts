import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  compareProcessStartToken,
  PROCESS_START_TOKEN_PREFIX,
  processStartToken,
} from "./processStartToken.ts";

const helper = new URL("./processStartToken.ts", import.meta.url).href;

/** Reads the real token for `pid` from a separate process running under `env`. */
function tokenFromChild(pid: number, env: Record<string, string>) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { processStartToken } from ${JSON.stringify(helper)};
       process.stdout.write(processStartToken(${pid}) ?? "unavailable");`,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } },
  );
}

describe("processStartToken", () => {
  it.skipIf(process.platform === "win32")(
    "is identical for the same live process under different time zones and locales",
    () => {
      const utc = tokenFromChild(process.pid, { TZ: "UTC", LC_ALL: "C" });
      const local = tokenFromChild(process.pid, {
        TZ: "Asia/Tokyo",
        LC_ALL: "de_DE.UTF-8",
        LANG: "de_DE.UTF-8",
      });
      expect(utc.startsWith(PROCESS_START_TOKEN_PREFIX)).toBe(true);
      expect(local).toBe(utc);
      expect(processStartToken(process.pid)).toBe(utc);
    },
  );

  it("is unavailable for a process that does not exist", () => {
    expect(processStartToken(2_147_483_000)).toBeUndefined();
  });
});

describe("compareProcessStartToken", () => {
  const token = (value: string, scheme = "ps-utc") =>
    `${PROCESS_START_TOKEN_PREFIX}${scheme}:${value}`;

  it("proves reuse only for two comparable tokens of one scheme that differ", () => {
    expect(compareProcessStartToken(token("a"), token("a"))).toBe("same");
    expect(compareProcessStartToken(token("a"), token("b"))).toBe("different");
  });

  it.each([
    ["a legacy locale-dependent token", "Thu_Oct_15_05:47:29_2026", token("a")],
    ["a pid placeholder", "pid:41", token("a")],
    ["a missing recorded token", null, token("a")],
    ["an unobtainable current token", token("a"), undefined],
    ["a different scheme", token("a", "linux"), token("b")],
  ] as const)("is unknown (fail closed) for %s", (_label, recorded, current) => {
    expect(compareProcessStartToken(recorded, current)).toBe("unknown");
  });
});
