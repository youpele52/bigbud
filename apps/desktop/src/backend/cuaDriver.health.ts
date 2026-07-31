export type CuaDriverHealthOverall = "ok" | "degraded" | "failed";

export interface CuaDriverHealthReport {
  readonly overall: CuaDriverHealthOverall;
  readonly diagnostics: string | null;
  readonly failedChecks: ReadonlyArray<string>;
  readonly repairRequired: boolean;
}

const PERMISSION_CHECKS = new Set([
  "ax_capability",
  "bundle_identity",
  "screen_capture_capability",
  "tcc_accessibility",
  "tcc_screen_recording",
]);

function readTextBlocks(result: Record<string, unknown>): string | null {
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const text = (entry as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

export function parseCuaDriverHealthReport(result: unknown): CuaDriverHealthReport {
  if (!result || typeof result !== "object") {
    throw new Error("cua-driver returned an invalid health report.");
  }
  const record = result as Record<string, unknown>;
  const structured = record.structuredContent;
  if (!structured || typeof structured !== "object") {
    throw new Error("cua-driver health report did not include structured content.");
  }
  const health = structured as Record<string, unknown>;
  const overall = health.overall;
  if (overall !== "ok" && overall !== "degraded" && overall !== "failed") {
    throw new Error("cua-driver health report has an unsupported overall status.");
  }
  const failedChecks = Array.isArray(health.checks)
    ? health.checks.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const check = entry as Record<string, unknown>;
        return check.status === "fail" && typeof check.name === "string" ? [check.name] : [];
      })
    : [];
  const permissionOnlyDegradation =
    overall === "degraded" &&
    failedChecks.length > 0 &&
    failedChecks.every((name) => PERMISSION_CHECKS.has(name));

  return {
    overall,
    diagnostics: readTextBlocks(record),
    failedChecks,
    repairRequired: overall === "failed" || (overall === "degraded" && !permissionOnlyDegradation),
  };
}
