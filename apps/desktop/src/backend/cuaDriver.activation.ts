import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";
import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverServeArguments,
} from "@bigbud/shared/cua-driver/invocation";

import { callCuaDriverTool } from "./cuaDriver.mcpClient";
import { runCommand } from "./cuaDriver.process";
import {
  assertCuaDriverProcessStartAllowed,
  stopTrackedCuaDriverProcess,
  trackCuaDriverProcess,
} from "./cuaDriver.processRegistry";

const ACTIVATION_TIMEOUT_MS = 10_000;
const VALIDATION_SOCKET_DIRECTORY_PREFIX = "/tmp/bigbud-cua-validation-";

export function createCuaDriverValidationEndpoint(): {
  readonly endpoint: string;
  readonly cleanupDirectory: string | null;
} {
  if (process.platform === "win32") {
    return {
      endpoint: `\\\\.\\pipe\\bigbud-cua-validation-${Crypto.randomUUID()}`,
      cleanupDirectory: null,
    };
  }
  const directory = FS.mkdtempSync(VALIDATION_SOCKET_DIRECTORY_PREFIX);
  FS.chmodSync(directory, 0o700);
  return { endpoint: Path.join(directory, "cua.sock"), cleanupDirectory: directory };
}

export async function validateCuaDriverActivation(input: {
  readonly binaryPath: string;
  readonly policyPath: string;
  readonly hostBundleId: string;
}): Promise<void> {
  assertCuaDriverProcessStartAllowed("cua-driver activation validation");
  const { endpoint, cleanupDirectory } = createCuaDriverValidationEndpoint();
  const environment = {
    CUA_DRIVER_POLICY_FILE: input.policyPath,
    ...cuaDriverEmbeddedEnvironment(endpoint, input.hostBundleId),
  };
  const child = trackCuaDriverProcess(
    ChildProcess.spawn(
      input.binaryPath,
      [
        ...cuaDriverServeArguments(endpoint, input.hostBundleId),
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
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Permission denied:")) return;
      throw error;
    }
    throw new Error("Computer Use runtime policy did not deny the activation probe.");
  } finally {
    stopTrackedCuaDriverProcess(child);
    if (cleanupDirectory) FS.rmSync(cleanupDirectory, { recursive: true, force: true });
  }
}
