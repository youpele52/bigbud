import * as Crypto from "node:crypto";
import * as FS from "node:fs";

import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";
import { parseCuaDriverManifest } from "@bigbud/shared/cua-driver/manifest";
import { CUA_DRIVER_POLICY_SHA256 } from "@bigbud/shared/cua-driver/policy";

import { runCommand } from "./cuaDriver.process";

export function validateCuaDriverPolicy(policyPath: string): void {
  const digest = Crypto.createHash("sha256").update(FS.readFileSync(policyPath)).digest("hex");
  if (digest !== CUA_DRIVER_POLICY_SHA256) {
    throw new Error("Computer Use runtime policy does not match the pinned policy digest.");
  }
}

export async function validateCuaDriverRuntime(
  binaryPath: string,
  policyPath?: string,
): Promise<void> {
  if (policyPath) validateCuaDriverPolicy(policyPath);
  const result = await runCommand(
    binaryPath,
    ["manifest"],
    makeCuaDriverChildEnvironment(process.env),
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "Computer Use runtime manifest command failed.");
  }
  const manifest = parseCuaDriverManifest(JSON.parse(result.stdout) as unknown);
  if (FS.realpathSync(manifest.binary_path) !== FS.realpathSync(binaryPath)) {
    throw new Error("Computer Use runtime manifest resolved a different executable.");
  }
}
