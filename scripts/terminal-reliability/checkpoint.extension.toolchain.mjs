import { readFileSync } from "node:fs";

export const buildOptions = Object.freeze({ target: "browser", format: "iife", minify: true });

export function projectCompilerPolicy() {
  const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const selected = root.packageManager?.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1];
  if (!selected || root.engines?.bun !== `^${selected}`)
    throw new Error("Unreviewed project Bun compiler policy");
  return { packageManager: root.packageManager, supported: root.engines.bun };
}

/** The compiler reports its own version, never a candidate manifest's version. */
export function installedCompilerFingerprint(runtime) {
  const policy = projectCompilerPolicy();
  if (
    !runtime ||
    !/^\d+\.\d+\.\d+$/.test(runtime.version) ||
    !runtime.semver.satisfies(runtime.version, policy.supported)
  )
    throw new Error(`Experimental compiler must satisfy declared ${policy.supported}`);
  return { version: runtime.version, policy, options: buildOptions };
}

export function compilerCommand() {
  return (
    process.env.BIGBUD_CHECKPOINT_BUN_BINARY ||
    (typeof Bun === "undefined" ? "bun" : process.execPath)
  );
}
