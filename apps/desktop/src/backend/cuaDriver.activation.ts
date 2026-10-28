import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  cuaDriverStateEnvironment,
  makeCuaDriverChildEnvironment,
} from "@bigbud/shared/cua-driver/childEnvironment";
import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverHonoursPidFile,
  cuaDriverServeArguments,
} from "@bigbud/shared/cua-driver/invocation";
import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";

import { callCuaDriverTool } from "./cuaDriver.mcpClient";
import { runCommand } from "./cuaDriver.process";
import {
  assertCuaDriverProcessStartAllowed,
  stopTrackedCuaDriverProcess,
  trackCuaDriverProcess,
} from "./cuaDriver.processRegistry";

const ACTIVATION_TIMEOUT_MS = 10_000;
const VALIDATION_SOCKET_DIRECTORY_PREFIX = "/tmp/bigbud-cua-validation-";

/**
 * One throwaway directory per validation run: the Unix socket (short `/tmp`
 * path), the Driver's PID file and its private state home, all removed with
 * the run so the validation daemon never touches shared Driver state.
 */
export function createCuaDriverValidationEndpoint(): {
  readonly endpoint: string;
  readonly cleanupDirectory: string;
  readonly pidFile: string;
  readonly stateHome: string;
} {
  const directory = FS.mkdtempSync(
    process.platform === "win32"
      ? Path.join(OS.tmpdir(), "bigbud-cua-validation-")
      : VALIDATION_SOCKET_DIRECTORY_PREFIX,
  );
  FS.chmodSync(directory, 0o700);
  const stateHome = Path.join(directory, "state");
  FS.mkdirSync(stateHome, { mode: 0o700 });
  return {
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\bigbud-cua-validation-${Crypto.randomUUID()}`
        : Path.join(directory, "cua.sock"),
    cleanupDirectory: directory,
    pidFile: Path.join(directory, "cua.pid"),
    stateHome,
  };
}

export async function validateCuaDriverActivation(input: {
  readonly binaryPath: string;
  readonly policyPath: string;
  readonly hostBundleId: string;
}): Promise<void> {
  assertCuaDriverProcessStartAllowed("cua-driver activation validation");
  const { endpoint, cleanupDirectory, pidFile, stateHome } = createCuaDriverValidationEndpoint();
  const environment = {
    CUA_DRIVER_POLICY_FILE: input.policyPath,
    ...cuaDriverStateEnvironment(stateHome),
    ...cuaDriverEmbeddedEnvironment(endpoint, input.hostBundleId),
  };
  const child = trackCuaDriverProcess(
    ChildProcess.spawn(
      input.binaryPath,
      [
        // The freshly installed binary is the pinned version by construction.
        ...cuaDriverServeArguments(
          endpoint,
          input.hostBundleId,
          cuaDriverHonoursPidFile(CUA_DRIVER_VERSION) ? { pidFile } : {},
        ),
        "--no-permissions-gate",
        "--no-overlay",
      ],
      {
        env: makeCuaDriverChildEnvironment(process.env, environment),
        stdio: ["ignore", "ignore", "pipe"],
        shell: false,
      },
    ),
  );
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4_096);
  });

  try {
    const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Computer Use validation daemon exited early. ${stderrTail}`.trim());
      }
      const status = await runCommand(
        input.binaryPath,
        ["status", "--socket", endpoint],
        makeCuaDriverChildEnvironment(process.env, environment),
        1_000,
      );
      if (status.code === 0) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `Computer Use validation daemon did not become ready. ${stderrTail}`.trim(),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await callCuaDriverTool(
      input.binaryPath,
      "health_report",
      {},
      {
        socketPath: endpoint,
        environment: makeCuaDriverChildEnvironment(process.env, environment),
      },
    );
    try {
      await callCuaDriverTool(
        input.binaryPath,
        "kill_app",
        { name: "bigbud-policy-probe" },
        {
          socketPath: endpoint,
          environment: makeCuaDriverChildEnvironment(process.env, environment),
          // 0.38 hides denied tools from tools/list; the call is still denied.
          allowUnadvertisedTool: true,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Permission denied:")) return;
      throw error;
    }
    throw new Error("Computer Use runtime policy did not deny the activation probe.");
  } finally {
    stopTrackedCuaDriverProcess(child);
    FS.rmSync(cleanupDirectory, { recursive: true, force: true });
  }
}
