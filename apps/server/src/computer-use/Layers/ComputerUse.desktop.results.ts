import type { ComputerUseActionOutcome, ComputerUseResult } from "@bigbud/contracts";
import { Effect } from "effect";

import type { CuaDriverCallResult, CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUseError } from "../Services/ComputerUse.ts";
import { actionOutcome, refusedActionMessage } from "./ComputerUse.desktop.outcome.ts";

export interface DesktopToolResult {
  readonly structuredContent?: unknown;
  readonly screenshot?: ComputerUseResult["screenshot"];
  readonly text?: string;
  readonly detailsJson?: string;
  readonly actionOutcome?: ComputerUseActionOutcome;
}

export function toError(cause: unknown, fallback: string): ComputerUseError {
  if (cause instanceof ComputerUseError) return cause;
  if (cause instanceof Error) return new ComputerUseError({ message: cause.message, cause });
  return new ComputerUseError({ message: fallback, cause });
}

export function stringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value, null, 2);
  return text.length <= 64 * 1024 ? text : `${text.slice(0, 64 * 1024)}\n…[truncated]`;
}

export function firstText(result: CuaDriverCallResult): string | undefined {
  return result.content.find((entry) => typeof entry.text === "string" && entry.text.length > 0)
    ?.text;
}

export function mutationSummary(
  action: string,
  target: string,
  outcome: ComputerUseActionOutcome | undefined,
): string {
  if (outcome?.effect === "confirmed" || outcome?.verified === true) {
    return `Completed and verified ${action} on ${target}.`;
  }
  if (outcome?.effect === "suspected_noop") {
    return `Sent ${action} to ${target}, but it may not have taken effect; do not assume it succeeded.`;
  }
  if (outcome?.effect === "unverifiable") {
    return `Sent ${action} to ${target}, but the result could not be verified; capture state before continuing.`;
  }
  return `Sent ${action} to ${target}; the driver did not provide a verification outcome.`;
}

function firstImage(result: CuaDriverCallResult): ComputerUseResult["screenshot"] {
  const entry = result.content.find(
    (candidate) =>
      candidate.type === "image" &&
      typeof candidate.data === "string" &&
      typeof candidate.mimeType === "string",
  );
  return entry?.data && entry.mimeType
    ? { mimeType: entry.mimeType, dataBase64: entry.data }
    : undefined;
}

export function callDesktopTool(
  driver: CuaDriverShape,
  name: string,
  args: Record<string, unknown>,
): Effect.Effect<DesktopToolResult, ComputerUseError> {
  return driver.callTool(name, args).pipe(
    Effect.flatMap((result) => {
      // A refused action is an error: the model must never be told "Sent ...".
      const refused = refusedActionMessage(name, result.structuredContent);
      return refused
        ? Effect.fail(new ComputerUseError({ message: refused }))
        : Effect.succeed(result);
    }),
    Effect.map((result) => {
      const screenshot = firstImage(result);
      const text = firstText(result);
      const detailsJson = stringify(result.structuredContent);
      const outcome = actionOutcome(result.structuredContent);
      return {
        structuredContent: result.structuredContent,
        ...(screenshot ? { screenshot } : {}),
        ...(text ? { text } : {}),
        ...(detailsJson ? { detailsJson } : {}),
        ...(outcome ? { actionOutcome: outcome } : {}),
      };
    }),
    Effect.mapError((cause) => toError(cause, `Desktop computer-use tool '${name}' failed.`)),
  );
}
