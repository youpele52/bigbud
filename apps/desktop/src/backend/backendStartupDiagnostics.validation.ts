import type {
  DesktopBackendStartupDiagnostics,
  DesktopBackendDevelopmentDiagnostics,
  DesktopBackendStartupFailureReason,
  DesktopBackendStartupState,
} from "@bigbud/contracts/server/ipc.desktop.ts";
import {
  MAX_STARTUP_ERROR_MESSAGE_LENGTH,
  MAX_STARTUP_STDERR_TAIL_LENGTH,
  MAX_DEVELOPMENT_DIAGNOSTICS_LENGTH,
  redactBackendDiagnosticText,
} from "./backendStartupDiagnostics";

const reasons = new Set<DesktopBackendStartupFailureReason>([
  "server_entry_missing",
  "bootstrap_failed",
  "child_spawn_failed",
  "child_exit_before_ready",
  "projection_database_initialization_failed",
  "server_runtime_startup_failed",
  "startup_timed_out",
  "unknown",
]);
const categories = new Set<DesktopBackendStartupDiagnostics["category"]>([
  "bootstrap",
  "process",
  "runtime",
  "timeout",
]);
const unsafeText =
  /(?:\/[\w.~/-]+|[a-z]:\\|\b(?:select|insert|update|delete|create\s+table)\b|\b(?:bearer|basic)\s+(?!\[REDACTED\])|\b(?:sk-|sk-ant-|gh[pousr]_)|\b(?:token|api[_-]?key|secret|password|authorization|cookie)\s*[:=]\s*(?!\[REDACTED\]))/iu;

function isSafeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !unsafeText.test(value)
  );
}

function isFailureReason(value: unknown): value is DesktopBackendStartupFailureReason {
  return typeof value === "string" && reasons.has(value as DesktopBackendStartupFailureReason);
}

function isDiagnostics(value: unknown): value is DesktopBackendStartupDiagnostics {
  if (typeof value !== "object" || value === null) return false;
  const diagnostic = value as Record<string, unknown>;
  return (
    typeof diagnostic.category === "string" &&
    categories.has(diagnostic.category as DesktopBackendStartupDiagnostics["category"]) &&
    typeof diagnostic.occurredAt === "string" &&
    Number.isFinite(Date.parse(diagnostic.occurredAt)) &&
    (diagnostic.errorMessage === undefined ||
      isSafeText(diagnostic.errorMessage, MAX_STARTUP_ERROR_MESSAGE_LENGTH)) &&
    (diagnostic.stderrTail === undefined ||
      isSafeText(diagnostic.stderrTail, MAX_STARTUP_STDERR_TAIL_LENGTH)) &&
    (diagnostic.exitCode === undefined ||
      (typeof diagnostic.exitCode === "number" && Number.isInteger(diagnostic.exitCode))) &&
    (diagnostic.exitSignal === undefined ||
      (typeof diagnostic.exitSignal === "string" && /^[A-Z0-9]+$/u.test(diagnostic.exitSignal)))
  );
}

function isDevelopmentDiagnostics(value: unknown): value is DesktopBackendDevelopmentDiagnostics {
  if (typeof value !== "object" || value === null) return false;
  const diagnostics = value as Record<string, unknown>;
  const text = [
    diagnostics.errorCause,
    diagnostics.errorMessage,
    diagnostics.errorName,
    diagnostics.errorStack,
    diagnostics.stderrTail,
  ];
  const textLength = text.reduce<number>(
    (length, value) => length + (typeof value === "string" ? value.length : 0),
    0,
  );
  return (
    typeof diagnostics.capturedAt === "string" &&
    Number.isFinite(Date.parse(diagnostics.capturedAt)) &&
    text.every(
      (value) =>
        value === undefined ||
        (typeof value === "string" &&
          value.length <= MAX_DEVELOPMENT_DIAGNOSTICS_LENGTH &&
          redactBackendDiagnosticText(value) === value),
    ) &&
    textLength <= MAX_DEVELOPMENT_DIAGNOSTICS_LENGTH &&
    (diagnostics.exitCode === undefined ||
      (typeof diagnostics.exitCode === "number" && Number.isInteger(diagnostics.exitCode))) &&
    (diagnostics.exitSignal === undefined ||
      (typeof diagnostics.exitSignal === "string" && /^[A-Z0-9]+$/u.test(diagnostics.exitSignal)))
  );
}

/** Validates the only startup diagnostics shape accepted by the preload boundary. */
export function isBackendStartupState(
  value: unknown,
  allowDevelopmentDiagnostics = false,
): value is DesktopBackendStartupState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  const status = state.status;
  const statusValid =
    status === "idle" ||
    status === "starting" ||
    status === "upgrading" ||
    status === "ready" ||
    status === "failed" ||
    status === "timedOut";
  return (
    Number.isInteger(state.generation) &&
    typeof state.startedAt === "number" &&
    Number.isFinite(state.startedAt) &&
    statusValid &&
    (state.failureReason === undefined || isFailureReason(state.failureReason)) &&
    (state.diagnostics === undefined || isDiagnostics(state.diagnostics)) &&
    (state.developmentDiagnostics === undefined ||
      (allowDevelopmentDiagnostics && isDevelopmentDiagnostics(state.developmentDiagnostics)))
  );
}
