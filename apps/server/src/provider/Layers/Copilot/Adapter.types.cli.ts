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

function buildNodeWrapper(input: {
  readonly cliPath: string;
  readonly nodeExecutablePath: string;
  readonly platform: NodeJS.Platform;
}): { readonly wrapperPath: string; readonly content: string } {
  const id = randomUUID();

  if (input.platform === "win32") {
    return {
      wrapperPath: join(tmpdir(), `copilot-node-wrapper-${id}.cmd`),
      content: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${input.nodeExecutablePath}" "${input.cliPath}" %*\r\n`,
    };
  }

  return {
    wrapperPath: join(tmpdir(), `copilot-node-wrapper-${id}.sh`),
    content: `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${input.nodeExecutablePath}" "${input.cliPath}" "$@"\n`,
  };
}

export function makeNodeWrapperCliPath(): string | undefined {
  if (!("electron" in process.versions)) return undefined;
  const cliPath = resolveCopilotCliPath();
  if (!cliPath) return undefined;
  const wrapper = buildNodeWrapper({
    cliPath,
    nodeExecutablePath: process.execPath,
    platform: process.platform,
  });
  writeFileSync(wrapper.wrapperPath, wrapper.content, "utf8");
  chmodSync(wrapper.wrapperPath, 0o755);
  return wrapper.wrapperPath;
}

export { buildNodeWrapper };
