import type {
  DesktopBackendStartupDiagnosticCategory,
  DesktopBackendDevelopmentDiagnostics,
  DesktopBackendStartupDiagnostics,
} from "@bigbud/contracts/server/ipc.desktop.ts";

export const MAX_STARTUP_ERROR_MESSAGE_LENGTH = 300;
export const MAX_STARTUP_STDERR_TAIL_LENGTH = 1_000;
export const MAX_DEVELOPMENT_DIAGNOSTICS_LENGTH = 24 * 1_024;
const MAX_DEVELOPMENT_ERROR_LENGTH = 4_096;
const MAX_DEVELOPMENT_STACK_LENGTH = 8_192;
const MAX_DEVELOPMENT_STDERR_TAIL_LENGTH = 12_288;

const REDACTED = "[REDACTED]";
const sensitiveValue =
  "(?:auth(?:entication)?(?:[_-]?token|token)|token|api[_-]?key|secret|password|authorization|cookie|session(?:[_-]?id)?)";
const unsafeContent = /\b(?:prompt|conversation|SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b/iu;
const absolutePath = /(?:^|\s)(?:\/[\w.~/-]+|[a-z]:\\[^\s]+)/iu;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function replaceUnsafeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") ||
      code === 127
      ? " "
      : character;
  }).join("");
}

/** Redacts credentials while retaining local diagnostic context such as stacks and paths. */
export function redactBackendDiagnosticText(value: string): string {
  return value
    .replace(/(?:https?|wss?):\/\/[^\s@/:]+:[^\s@/]+@[^\s)\]}>,]+/giu, "[REDACTED_URL]")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9+/=_-]+/giu, REDACTED)
    .replace(
      /\b(?:sk-[a-z0-9_-]{8,}|sk-ant-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_-]{8,})\b/giu,
      REDACTED,
    )
    .replace(new RegExp(`(${sensitiveValue})\\s*[:=]\\s*([^\\s,;]+)`, "giu"), `$1=${REDACTED}`)
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|COOKIE)[A-Z0-9_]*)\s*=\s*[^\s,;]+/gu,
      `$1=${REDACTED}`,
    )
    .replace(/\b(?:authorization|cookie)\s*:\s*[^\r\n]+/giu, `$&`.replace(/:.*/u, `: ${REDACTED}`));
}

export function sanitizeLocalBackendDiagnosticText(value: unknown, maxLength = 8_192): string {
  if (typeof value !== "string") return "";
  return truncate(
    replaceUnsafeControlCharacters(redactBackendDiagnosticText(value)),
    maxLength,
  ).trim();
}

/** Sanitizes untrusted child-process text before it can cross Electron IPC. */
export function sanitizeBackendStartupText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = replaceUnsafeControlCharacters(value)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !absolutePath.test(line))
    .filter((line) => !unsafeContent.test(line))
    .map(redactBackendDiagnosticText);
  const result = truncate(lines.join("\n"), maxLength).trim();
  return result || undefined;
}

export function createBackendStartupDiagnostics(input: {
  readonly category: DesktopBackendStartupDiagnosticCategory;
  readonly errorMessage?: unknown;
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  readonly stderrTail?: unknown;
}): DesktopBackendStartupDiagnostics {
  const errorMessage = sanitizeBackendStartupText(
    input.errorMessage,
    MAX_STARTUP_ERROR_MESSAGE_LENGTH,
  );
  const stderrTail = sanitizeBackendStartupText(input.stderrTail, MAX_STARTUP_STDERR_TAIL_LENGTH);
  return {
    category: input.category,
    occurredAt: new Date().toISOString(),
    ...(errorMessage ? { errorMessage } : {}),
    ...(typeof input.exitCode === "number" && Number.isInteger(input.exitCode)
      ? { exitCode: input.exitCode }
      : {}),
    ...(typeof input.exitSignal === "string" && /^[A-Z0-9]+$/u.test(input.exitSignal)
      ? { exitSignal: input.exitSignal }
      : {}),
    ...(stderrTail ? { stderrTail } : {}),
  };
}

function getErrorCause(error: Error): unknown {
  return "cause" in error ? error.cause : undefined;
}

function formatDiagnosticValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return String(value);
  } catch {
    return "[unprintable error value]";
  }
}

/**
 * Bounds and redacts main-process crash context intended only for an unpackaged
 * development renderer. Paths and stacks are retained to make local crashes actionable.
 */
export function createDevelopmentBackendDiagnostics(input: {
  readonly error?: unknown;
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  readonly stderrTail?: unknown;
}): DesktopBackendDevelopmentDiagnostics {
  const error = input.error instanceof Error ? input.error : undefined;
  const values = {
    errorCause: error
      ? sanitizeLocalBackendDiagnosticText(
          formatDiagnosticValue(getErrorCause(error)),
          MAX_DEVELOPMENT_ERROR_LENGTH,
        )
      : "",
    errorMessage: sanitizeLocalBackendDiagnosticText(
      error?.message ?? formatDiagnosticValue(input.error),
      MAX_DEVELOPMENT_ERROR_LENGTH,
    ),
    errorName: sanitizeLocalBackendDiagnosticText(error?.name, 256),
    errorStack: sanitizeLocalBackendDiagnosticText(error?.stack, MAX_DEVELOPMENT_STACK_LENGTH),
    stderrTail: sanitizeLocalBackendDiagnosticText(
      input.stderrTail,
      MAX_DEVELOPMENT_STDERR_TAIL_LENGTH,
    ),
  };
  let remaining = MAX_DEVELOPMENT_DIAGNOSTICS_LENGTH;
  const bounded = Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const result = truncate(value, remaining);
      remaining -= result.length;
      return [key, result];
    }),
  ) as Record<keyof typeof values, string>;
  return {
    capturedAt: new Date().toISOString(),
    ...(bounded.errorCause ? { errorCause: bounded.errorCause } : {}),
    ...(bounded.errorMessage ? { errorMessage: bounded.errorMessage } : {}),
    ...(bounded.errorName ? { errorName: bounded.errorName } : {}),
    ...(bounded.errorStack ? { errorStack: bounded.errorStack } : {}),
    ...(typeof input.exitCode === "number" && Number.isInteger(input.exitCode)
      ? { exitCode: input.exitCode }
      : {}),
    ...(typeof input.exitSignal === "string" && /^[A-Z0-9]+$/u.test(input.exitSignal)
      ? { exitSignal: input.exitSignal }
      : {}),
    ...(bounded.stderrTail ? { stderrTail: bounded.stderrTail } : {}),
  };
}
