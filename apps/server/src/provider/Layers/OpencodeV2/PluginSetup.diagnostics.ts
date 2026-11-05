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

export type V2DiagnosticCode =
  | "source-shape"
  | "source-bounds"
  | "source-root"
  | "source-phase"
  | "source-duplicate"
  | "permission-unsupported"
  | "permission-denied"
  | "policy-unsupported"
  | "policy-denied"
  | "registration-unverified"
  | "health-unverified"
  | "contract-unverified"
  | "generation-mismatch"
  | "storage-namespace-mismatch"
  | "acquisition-unverified";
export type V2DiagnosticStage = "config-sources" | "config-controls" | "acquisition";
const diagnosticCodes = new Set<string>([
  "source-shape",
  "source-bounds",
  "source-root",
  "source-phase",
  "source-duplicate",
  "permission-unsupported",
  "permission-denied",
  "policy-unsupported",
  "policy-denied",
  "registration-unverified",
  "health-unverified",
  "contract-unverified",
  "generation-mismatch",
  "storage-namespace-mismatch",
  "acquisition-unverified",
]);
const bounded = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value! >= 0 && value! <= 256;

/** Runtime allowlist as well as types: never spread arbitrary metadata or retain a cause. */
export class V2DiagnosticError extends Error {
  readonly diagnostic: Readonly<{
    stage: V2DiagnosticStage;
    code: V2DiagnosticCode;
    sourceIndex?: number;
    sourceCount?: number;
  }>;
  constructor(stage: V2DiagnosticStage, code: V2DiagnosticCode, index?: number, count?: number) {
    const safeStage = ["config-sources", "config-controls", "acquisition"].includes(stage)
      ? stage
      : "acquisition";
    const safeCode = diagnosticCodes.has(code) ? code : "acquisition-unverified";
    const diagnostic = Object.freeze({
      stage: safeStage,
      code: safeCode,
      ...(bounded(index) ? { sourceIndex: index } : {}),
      ...(bounded(count) ? { sourceCount: count } : {}),
    });
    super(
      `V2 verification blocked (${JSON.stringify(diagnostic)}); no automatic replay or setup override.`,
    );
    this.diagnostic = diagnostic;
  }
}
