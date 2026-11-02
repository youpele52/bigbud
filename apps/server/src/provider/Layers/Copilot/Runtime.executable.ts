import { realpathSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import Path from "node:path";
import { resolveCommandPath } from "../../../utils/commandPath.ts";

/** Unwrap only the known npm package layout. Never execute or interpret arbitrary shell shims. */
export function resolveExternalCopilot(
  binary: string,
  packageName: string | undefined,
  env = process.env,
): string | undefined {
  let found = resolveCommandPath(binary, { env });
  if (!found && binary.endsWith(".js") && existsSync(binary) && statSync(binary).isFile())
    found = binary;
  if (!found) return undefined;
  if (/\.(cmd|bat)$/i.test(found)) {
    if (!packageName) return undefined;
    for (const candidate of [
      Path.join(Path.dirname(found), "node_modules", "@github", "copilot", "npm-loader.js"),
      Path.resolve(Path.dirname(found), "..", "@github", "copilot", "npm-loader.js"),
    ]) {
      if (!existsSync(candidate)) continue;
      try {
        return createRequire(candidate).resolve(packageName);
      } catch {
        /* Try the other standard npm layout. */
      }
    }
    return undefined;
  }
  const target = realpathSync(found);
  // npm's JS loader needs Node, but native dispatchers (e.g. Snap aliases) need argv[0] preserved.
  return target.endsWith(".js") ? target : Path.resolve(found);
}

/** Read the SDK package layout without materializing its cache or downloading anything. */
export function sdkCopilotExecutable(target: string): string | undefined {
  try {
    const require = createRequire(createRequire(import.meta.url).resolve("@github/copilot-sdk"));
    const root = Path.dirname(require.resolve(`@github/copilot-sdk-${target}/package.json`));
    const binary = Path.join(
      root,
      "prebuilds",
      target,
      target.startsWith("win32") ? "copilot-runtime.exe" : "copilot-runtime",
    );
    return existsSync(binary) && existsSync(Path.join(Path.dirname(binary), "runtime.node"))
      ? binary
      : undefined;
  } catch {
    return undefined;
  }
}
