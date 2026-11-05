import { randomUUID } from "node:crypto";
import { runSshCommand } from "../ssh/sshProcess.ts";
import { SSH_CANCEL_COMMAND, SSH_OWNED_COMMAND } from "../ssh/sshCommand.cancellation.ts";
import {
  CommandCancellationUnconfirmedError,
  withCommandCancellation,
} from "../utils/commandCancellation.ts";
import type { RunSshToolCommandInput } from "./toolTransport.ssh.ts";

/** A separate SSH control request terminates and verifies the exact remote process group. */
export async function runCancellableSshToolCommand(
  input: Omit<RunSshToolCommandInput, "env"> & {
    readonly env?: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) {
  input.signal.throwIfAborted();
  const directory = `/tmp/bigbud-tool-${randomUUID()}`;
  const control = (script: string, args: string[] = []) =>
    runSshCommand({
      executionTargetId: input.executionTargetId,
      command: "sh",
      args: ["-c", script, "bigbud-tool-control", directory, ...args],
      timeoutMs: 10_000,
      maxBufferBytes: 4096,
    });
  await control('umask 077; mkdir -m 700 "$1"');
  let confirmed = true;
  let launched = false;
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => (cancellation ??= control(SSH_CANCEL_COMMAND));
  try {
    input.signal.throwIfAborted();
    return await withCommandCancellation(
      input.signal,
      async () => {
        launched = true;
        confirmed = false;
        try {
          const result = await runSshCommand({
            executionTargetId: input.executionTargetId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
            ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
            // Do not kill the ssh observer on abort: first terminate the remote process group.
            command: "sh",
            args: [
              "-c",
              SSH_OWNED_COMMAND,
              "bigbud-owned-tool",
              directory,
              input.command,
              ...(input.args ?? []),
            ],
            allowNonZeroExit: true,
          });
          // An ssh observer exit (including code 255) is never remote-terminal evidence.
          // Verify the owned group through the control channel, stopping any surviving children.
          await cancel();
          confirmed = true;
          if (result.timedOut) throw new Error("Remote command timed out.");
          if (!input.allowNonZeroExit && result.code !== 0)
            throw new Error(`Remote command failed (code=${result.code}). ${result.stderr.trim()}`);
          return result;
        } catch (cause) {
          if (!confirmed) {
            try {
              await cancel();
              confirmed = true;
            } catch (error) {
              throw new CommandCancellationUnconfirmedError(error);
            }
          }
          throw cause;
        }
      },
      async () => {
        if (launched) await cancel();
        confirmed = true;
      },
    );
  } finally {
    // Retain control evidence on an uncertain outcome; never report an orphan as stopped.
    if (confirmed) await control('rm -rf -- "$1"').catch(() => {});
  }
}
