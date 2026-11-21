import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { layer as nodePtyLayer } from "../terminal/Layers/NodePTY.ts";
import { createTerminalSpawnEnv } from "../terminal/Layers/Manager.shell.ts";
import { withInteractiveTerminalIdentity } from "../terminal/Layers/Manager.shell.identity.ts";
import { PtyAdapter, type PtyAdapterShape, type PtyProcess } from "../terminal/Services/PTY.ts";
import {
  installShellIntegration,
  shellIntegrationEnv,
  shellIntegrationRoot,
} from "../terminal/shellIntegration/shellIntegration.ts";
import {
  collectLocalTerminalHostRuntimes,
  resolveLocalTerminalHostSource,
  stageLocalTerminalHostBinary,
  verifyStagedLocalTerminalHostBinary,
} from "./localTerminalHost.binary.ts";
import { makeLocalTerminalHostController } from "./localTerminalHost.host.ts";
import {
  launchLocalTerminalHost,
  prepareLocalTerminalHostGeneration,
} from "./localTerminalHost.launch.ts";
import {
  LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
  type LocalTerminalHostPaths,
} from "./localTerminalHost.paths.ts";
import { probeLocalTerminalHost } from "./localTerminalHost.probe.ts";
import type { LocalTerminalHostProcesses } from "./localTerminalHost.process.ts";
import { makeLocalTerminalHostRegistry } from "./localTerminalHost.registry.ts";

/** A controller wired exactly like the layer, against the real staged binary. */
export function realLocalTerminalHostController(
  paths: LocalTerminalHostPaths,
  processes: LocalTerminalHostProcesses,
  generationHasOwners: (connectionId: string, epoch: string | undefined) => Promise<boolean> = () =>
    Promise.resolve(false),
) {
  return makeLocalTerminalHostController({
    mode: "enabled",
    paths,
    registry: makeLocalTerminalHostRegistry(paths),
    processes,
    requiredCapabilities: LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
    generationHasOwners,
    log: () => {},
    stage: async () => stageLocalTerminalHostBinary(paths, resolveLocalTerminalHostSource()),
    verifyStaged: (staged) => verifyStagedLocalTerminalHostBinary(paths, staged),
    collectRuntimes: (keep) => collectLocalTerminalHostRuntimes(paths, keep),
    probe: (generation, proxyBinary) => probeLocalTerminalHost({ generation, proxyBinary }),
    prepareGeneration: (generation) => prepareLocalTerminalHostGeneration(paths.root, generation),
    launch: (input) => launchLocalTerminalHost(input),
  });
}

/** Splits `env -0` output; values may span lines, never NUL. */
export function parseEnvZero(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) result[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return result;
}

/** The user's real login environment (`$SHELL -lic env`), as the desktop app captures it. */
export function captureLoginEnvironment(): Record<string, string> {
  const shell = process.env.SHELL || "/bin/sh";
  const marker = "BBTH_LOGIN_ENV_BEGIN";
  const result = spawnSync(shell, ["-lic", `printf ${marker}; /usr/bin/env -0`], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const start = result.stdout.lastIndexOf(marker);
  if (start < 0) throw new Error("The login environment could not be captured.");
  return parseEnvZero(result.stdout.slice(start + marker.length));
}

/** What `startSessionWith` passes to the adapter for a local pane (spawn env plus integration). */
export async function managerSpawnEnvironment(
  login: Record<string, string>,
  stateDir: string,
): Promise<NodeJS.ProcessEnv> {
  const files = await installShellIntegration(shellIntegrationRoot(stateDir));
  const base = withInteractiveTerminalIdentity(createTerminalSpawnEnv(login, null));
  return { ...base, ...shellIntegrationEnv(files, base, true) };
}

/** Names whose values differ or exist on one side only; values are never reported. */
export function differingNames(
  left: Record<string, string | undefined>,
  right: Record<string, string | undefined>,
  ignore: ReadonlySet<string> = new Set(),
): ReadonlyArray<string> {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names].filter((name) => !ignore.has(name) && left[name] !== right[name]).toSorted();
}

/** Shell-maintained variables that are not part of a launch environment. */
export const SHELL_MANAGED_NAMES: ReadonlySet<string> = new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  // The bash integration removes its bootstrap and un-exports PROMPT_COMMAND (by design).
  "PROMPT_COMMAND",
]);

/** OSC 133 (shell integration) and OSC 7 (cwd) sequences, in order. */
export function integrationMarkers(output: string): ReadonlyArray<string> {
  // eslint-disable-next-line no-control-regex -- OSC sequences are delimited by ESC and BEL.
  const pattern = /\u001b\]((?:133|7);[^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
  return [...output.matchAll(pattern)].map((match) => match[1]!);
}

export function nodePtyAdapter(): Promise<PtyAdapterShape> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* PtyAdapter;
    }).pipe(Effect.provide(nodePtyLayer.pipe(Layer.provide(NodeServices.layer)))),
  );
}

export interface PtyRecorder {
  readonly output: () => string;
  readonly waitFor: (needle: string, from?: number, timeoutMs?: number) => Promise<number>;
  readonly dispose: () => void;
}

export function recordPty(process: PtyProcess): PtyRecorder {
  let output = "";
  const remove = process.onData((data) => {
    output += data;
  });
  return {
    output: () => output,
    waitFor: async (needle, from = 0, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = output.indexOf(needle, from);
        if (index >= 0) return index;
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in terminal output.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    dispose: remove,
  };
}

/**
 * Runs one command and waits for its completion line. The `%s` split keeps the shell's echo of
 * the typed command from matching.
 */
export async function runCommand(
  process: PtyProcess,
  recorder: PtyRecorder,
  command: string,
  token: string,
): Promise<{ readonly start: number; readonly end: number }> {
  const start = recorder.output().length;
  process.write(`${command}; printf 'BBTH_%s\\n' ${token}\r`);
  const end = await recorder.waitFor(`BBTH_${token}`, start);
  return { start, end };
}

export async function readEnvFile(path: string): Promise<Record<string, string>> {
  return parseEnvZero(await readFile(path, "utf8"));
}
