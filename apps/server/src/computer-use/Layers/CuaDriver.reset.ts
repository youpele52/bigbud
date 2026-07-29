import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";

import { runProcess } from "../../utils/processRunner.ts";

const RESET_TIMEOUT_MS = 20_000;

export async function resetCuaDriverDaemon(input: {
  readonly command: string;
  readonly socketPath: string;
  readonly reason: string;
}): Promise<void> {
  await runProcess(input.command, ["stop", "--socket", input.socketPath], {
    allowNonZeroExit: true,
    timeoutMs: 5_000,
    outputMode: "truncate",
    env: makeCuaDriverChildEnvironment(process.env),
  });
  const deadline = Date.now() + RESET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await runProcess(input.command, ["status", "--socket", input.socketPath], {
      allowNonZeroExit: true,
      timeoutMs: 1_000,
      outputMode: "truncate",
      env: makeCuaDriverChildEnvironment(process.env),
    });
    if (status.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Computer Use daemon reset did not recover after an uncertain action: ${input.reason}`,
  );
}
