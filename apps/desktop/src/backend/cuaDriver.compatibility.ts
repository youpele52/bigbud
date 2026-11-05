import {
  makeCuaDriverChildEnvironment,
  cuaDriverStateEnvironment,
} from "@bigbud/shared/cua-driver/childEnvironment";
import { cuaDriverHonoursPidFile } from "@bigbud/shared/cua-driver/invocation";

import { validateCuaDriverRuntime } from "./cuaDriver.manifest";
import { runCommand } from "./cuaDriver.process";

/** Probe unfamiliar releases instead of inferring CLI capabilities from their version. */
export async function inspectCuaDriverCompatibility(
  binaryPath: string,
  policyPath: string | undefined,
  stateHome: string,
): Promise<{ version: string; honoursPidFile: boolean }> {
  const manifest = await validateCuaDriverRuntime(binaryPath, policyPath, stateHome, 2_000);
  const version = manifest.binary_version;
  if (version === "0.9.1" || version === "0.38.0") {
    return { version, honoursPidFile: cuaDriverHonoursPidFile(version) };
  }
  const result = await runCommand(
    binaryPath,
    ["serve", "--help"],
    makeCuaDriverChildEnvironment(process.env, cuaDriverStateEnvironment(stateHome)),
    2_000,
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "Could not inspect cua-driver embedded serve capabilities.");
  }
  const flags = new Set(`${result.stdout}\n${result.stderr}`.match(/--[a-z][a-z-]*/g) ?? []);
  for (const flag of ["--embedded", "--socket", "--host-bundle-id", "--pid-file"]) {
    if (!flags.has(flag))
      throw new Error(`cua-driver does not advertise required serve flag ${flag}.`);
  }
  return { version, honoursPidFile: true };
}
