import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";

export interface ManagedServerErrorConfig {
  readonly provider: "opencode" | "kilocode";
  readonly displayName: string;
  readonly defaultBinary: string;
}

export function formatMissingOpencodeBinaryDetail(input: {
  readonly provider?: ManagedServerErrorConfig["provider"];
  readonly binaryPath: string;
  readonly executionTargetId: string;
  readonly detail: string;
}): string | null {
  const config =
    input.provider === "kilocode"
      ? { displayName: "KiloCode", defaultBinary: "kilo" }
      : { displayName: "OpenCode", defaultBinary: "opencode" };
  const normalizedDetail = input.detail.trim();
  if (
    normalizedDetail.length === 0 ||
    !(
      /exec:\s+.+:\s+not found/i.test(normalizedDetail) ||
      /\bcommand not found\b/i.test(normalizedDetail) ||
      /\bspawn\b.+\benoent\b/i.test(normalizedDetail) ||
      /\bno such file or directory\b/i.test(normalizedDetail)
    )
  ) {
    return null;
  }

  const remote = input.executionTargetId !== LOCAL_EXECUTION_TARGET_ID;
  if (input.binaryPath === config.defaultBinary) {
    return remote
      ? `Remote ${config.displayName} CLI is not installed or not available on PATH. Install '${config.defaultBinary}' on the remote host or set Providers > ${config.displayName} > Binary path to the remote executable path.`
      : `${config.displayName} CLI is not installed or not available on PATH. Install '${config.defaultBinary}' locally or set Providers > ${config.displayName} > Binary path to the local executable path.`;
  }

  return remote
    ? `Remote ${config.displayName} binary was not found at '${input.binaryPath}'. Update Providers > ${config.displayName} > Binary path to the correct remote executable path.`
    : `${config.displayName} binary was not found at '${input.binaryPath}'. Update Providers > ${config.displayName} > Binary path to the correct local executable path.`;
}

export function normalizeManagedServerStartError(input: {
  readonly config: ManagedServerErrorConfig;
  readonly binaryPath: string;
  readonly executionTargetId: string;
  readonly error: unknown;
  readonly output: string;
}): Error {
  if (input.error instanceof Error) {
    const errnoCode = "code" in input.error ? input.error.code : undefined;
    if (errnoCode === "ENOENT") {
      const missingBinaryDetail = formatMissingOpencodeBinaryDetail({
        provider: input.config.provider,
        binaryPath: input.binaryPath,
        executionTargetId: input.executionTargetId,
        detail: input.error.message,
      });
      if (missingBinaryDetail) return new Error(missingBinaryDetail);
    }

    const missingBinaryDetail = formatMissingOpencodeBinaryDetail({
      provider: input.config.provider,
      binaryPath: input.binaryPath,
      executionTargetId: input.executionTargetId,
      detail: `${input.error.message}\n${input.output}`,
    });
    return missingBinaryDetail ? new Error(missingBinaryDetail) : input.error;
  }

  return new Error(`Failed to start ${input.config.displayName} server: ${String(input.error)}`);
}
