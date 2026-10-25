type SetupStage =
  | "config-scope"
  | "config-controls"
  | "plugin-inventory"
  | "manual-bootstrap"
  | "eligibility"
  | "publication"
  | "readiness"
  | "final-source";

const codes = new Set([
  "ENOENT",
  "EEXIST",
  "EACCES",
  "EPERM",
  "EIO",
  "ENOSPC",
  "EROFS",
  "ENOTDIR",
  "EMFILE",
  "ENFILE",
  "ELOOP",
  "EXDEV",
  "EBUSY",
  "ETIMEDOUT",
  "ECONNRESET",
]);

/** Only a finite diagnostic vocabulary escapes; SDK messages, paths and nested causes stay private. */
export function v2SetupFailureKind(error: unknown): string {
  if (error instanceof Error) {
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (typeof code === "string" && codes.has(code)) return code;
    if (error instanceof DOMException && error.name === "AbortError") return "aborted";
    if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
    if (error instanceof TypeError) return "type-error";
    if (error instanceof SyntaxError) return "syntax-error";
    if (error instanceof RangeError) return "range-error";
  }
  return "unclassified";
}

/** Preserve typed policy/busy errors; classify only errors the job would otherwise erase. */
export async function atV2SetupStage<T>(stage: SetupStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("V2 ")) throw error;
    // oxlint-disable-next-line preserve-caught-error -- Raw SDK/fs causes may retain credentials or private paths.
    throw new Error(
      `V2 setup failed at ${stage} (${v2SetupFailureKind(error)}); history/uncertain evidence was retained.`,
    );
  }
}
