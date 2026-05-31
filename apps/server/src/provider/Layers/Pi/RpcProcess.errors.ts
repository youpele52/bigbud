import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";

function formatMissingRemotePiBinaryDetail(input: {
  readonly binaryPath: string;
  readonly stderrTail: string;
}): string | null {
  const stderr = input.stderrTail.trim();
  if (!/exec:\s+.+:\s+not found/i.test(stderr)) {
    return null;
  }

  if (input.binaryPath === "pi") {
    return "Remote Pi CLI is not installed or not available on PATH. Install 'pi' on the remote host or set Providers > Pi > Binary path to the remote executable path.";
  }

  return `Remote Pi CLI was not found at '${input.binaryPath}'. Update Providers > Pi > Binary path to the correct remote executable path.`;
}

export function describePiExit(input: {
  readonly command: string;
  readonly binaryPath: string;
  readonly executionTargetId: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
}): Error {
  const missingRemoteBinaryDetail =
    input.executionTargetId !== LOCAL_EXECUTION_TARGET_ID
      ? formatMissingRemotePiBinaryDetail({
          binaryPath: input.binaryPath,
          stderrTail: input.stderrTail,
        })
      : null;
  if (missingRemoteBinaryDetail) {
    return new Error(missingRemoteBinaryDetail);
  }

  const stderr = input.stderrTail.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(
    `Pi RPC process '${input.command}' exited (code=${input.code ?? "null"}, signal=${input.signal ?? "null"}).${detail}`,
  );
}
