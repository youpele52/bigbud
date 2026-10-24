import * as Identity from "@bigbud/shared/processStartToken";

export const PROCESS_START_TOKEN_PREFIX = Identity.PROCESS_START_TOKEN_PREFIX;

/** Compatibility entry point for existing server consumers. */
export function processStartToken(pid: number): string | undefined {
  return Identity.processStartToken(pid);
}

export function compareProcessStartToken(
  recorded: string | null | undefined,
  current: string | undefined,
): "same" | "different" | "unknown" {
  return Identity.compareProcessStartToken(recorded, current);
}
