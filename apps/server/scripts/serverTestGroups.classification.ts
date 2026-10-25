import type { ProbeRecord } from "./serverTestGroups.guard.types.ts";

export interface TestFileResult {
  readonly status: string;
  readonly assertionResults?: ReadonlyArray<{ readonly status: string }>;
}

/** A passing suite is safe only when every assertion ran and the guard finished. */
export function classifyTestFileRun(
  result: TestFileResult,
  probe: ProbeRecord | undefined,
): string {
  if (result.status !== "passed") return result.status;
  if (probe === undefined) return "unfinished";
  if (
    !result.assertionResults?.length ||
    !result.assertionResults.every((assertion) => assertion.status === "passed")
  )
    return "incomplete";
  return "passed";
}
