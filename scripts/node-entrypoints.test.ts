import * as ChildProcess from "node:child_process";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Root scripts run under plain `node` (type stripping), which resolves only
 * explicit relative specifiers; Vitest resolves extensionless ones, so unit
 * tests alone cannot catch a broken chain. Regression for the Run 5 break:
 * `@bigbud/shared/computer-use/selection` and `cua-driver/release` stopped
 * being leaf modules and every `bun dev*` failed with ERR_MODULE_NOT_FOUND.
 */
const ROOT = Path.resolve(import.meta.dirname, "..");

function runNode(args: ReadonlyArray<string>) {
  return ChildProcess.spawnSync("node", [...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

const importUnderNode = (relative: string) =>
  runNode([
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(Path.join(ROOT, relative))});`,
  ]);

describe("scripts under plain node", () => {
  it("imports the dev-runner computer-use gate module", () => {
    const result = importUnderNode("scripts/dev-runner.computerUse.ts");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("starts the dev-runner CLI", () => {
    const result = runNode(["scripts/dev-runner.ts", "--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("dev-runner");
  });

  it("imports the desktop artifact Cua Driver module used by packaging", () => {
    const result = importUnderNode("scripts/lib/desktop-artifact/cuaDriver.ts");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
