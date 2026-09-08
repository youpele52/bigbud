import { createHash } from "node:crypto";

import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";

export const ORCHESTRATION_COMMAND_PAYLOAD_DIGEST_VERSION = "orchestration-command-payload/v1";

export interface OrchestrationCommandPayloadDigest {
  readonly version: typeof ORCHESTRATION_COMMAND_PAYLOAD_DIGEST_VERSION;
  readonly digest: string;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    const fieldValue = (value as Record<string, unknown>)[key];
    if (fieldValue !== undefined) {
      sorted[key] = sortValue(fieldValue);
    }
  }
  return sorted;
}

export function canonicalizeCommandPayload(command: OrchestrationCommand): string {
  const { commandId: _commandId, ...semanticCommand } = command;
  return JSON.stringify({
    version: ORCHESTRATION_COMMAND_PAYLOAD_DIGEST_VERSION,
    command: sortValue(semanticCommand),
  });
}

export function calculateCommandPayloadDigest(
  command: OrchestrationCommand,
): OrchestrationCommandPayloadDigest {
  return {
    version: ORCHESTRATION_COMMAND_PAYLOAD_DIGEST_VERSION,
    digest: createHash("sha256").update(canonicalizeCommandPayload(command)).digest("hex"),
  };
}

export function commandPayloadDigestMatches(
  command: OrchestrationCommand,
  expected: { readonly version: string; readonly digest: string },
): boolean {
  const actual = calculateCommandPayloadDigest(command);
  return actual.version === expected.version && actual.digest === expected.digest;
}
