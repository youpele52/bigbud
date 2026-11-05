import { callCuaDriverTool } from "./cuaDriver.mcpClient";

/** No app name or PID: even a policy-ignoring driver receives no kill target. */
export async function validateCuaDriverPolicyEnforcement(
  binaryPath: string,
  options: { socketPath: string; environment: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<void> {
  try {
    await callCuaDriverTool(
      binaryPath,
      "kill_app",
      {},
      {
        ...options,
        allowUnadvertisedTool: true,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /^Permission denied: (?:user policy: )?tool 'kill_app' is explicitly denied$/.test(
        error.message,
      )
    )
      return;
    throw new Error(
      `Computer Use runtime did not confirm policy denial of kill_app: ${String(error)}`,
      { cause: error },
    );
  }
  throw new Error("Computer Use runtime policy did not deny the activation probe.");
}
