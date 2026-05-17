import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function resolveCopilotCliPath(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const sdkMain = req.resolve("@github/copilot-sdk");
    const sdkMainDir = dirname(sdkMain);
    for (const githubDir of [join(sdkMainDir, "..", "..", ".."), join(sdkMainDir, "..", "..")]) {
      const candidate = join(githubDir, "copilot", "index.js");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // fall through
  }
  return undefined;
}

export function makeNodeWrapperCliPath(): string | undefined {
  if (!("electron" in process.versions)) return undefined;
  const cliPath = resolveCopilotCliPath();
  if (!cliPath) return undefined;
  const wrapperPath = join(tmpdir(), `copilot-node-wrapper-${randomUUID()}.sh`);
  writeFileSync(wrapperPath, `#!/bin/sh\nexec node ${JSON.stringify(cliPath)} "$@"\n`, "utf8");
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}
