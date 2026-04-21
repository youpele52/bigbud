import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import { app } from "electron";

import { RotatingFileSink } from "@bigbud/shared/logging";
import { parsePersistedServerObservabilitySettings } from "@bigbud/shared/serverSettings";

// ---------------------------------------------------------------------------
// Timestamp / scope helpers
// ---------------------------------------------------------------------------

export function logTimestamp(): string {
  return new Date().toISOString();
}

export function logScope(scope: string, runId: string): string {
  return `${scope} run=${runId}`;
}

export function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Persisted backend observability settings
// ---------------------------------------------------------------------------

export function readPersistedBackendObservabilitySettings(serverSettingsPath: string): {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
} {
  try {
    if (!FS.existsSync(serverSettingsPath)) {
      return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
    }
    return parsePersistedServerObservabilitySettings(FS.readFileSync(serverSettingsPath, "utf8"));
  } catch (error) {
    console.warn("[desktop] failed to read persisted backend observability settings", error);
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }
}

// ---------------------------------------------------------------------------
// Child environment
// ---------------------------------------------------------------------------

/** Returns a cleaned copy of process.env safe for the backend child process. */
export function backendChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.T3CODE_PORT;
  delete env.T3CODE_AUTH_TOKEN;
  delete env.T3CODE_MODE;
  delete env.T3CODE_NO_BROWSER;
  delete env.T3CODE_HOST;
  delete env.T3CODE_DESKTOP_WS_URL;
  return env;
}

// ---------------------------------------------------------------------------
// Structured log writers
// ---------------------------------------------------------------------------

export function writeDesktopLogHeader(
  message: string,
  desktopLogSink: RotatingFileSink | null,
  runId: string,
): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop", runId)}] ${message}\n`);
}

export function writeBackendSessionBoundary(
  phase: "START" | "END",
  details: string,
  backendLogSink: RotatingFileSink | null,
  runId: string,
): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${runId} ${normalizedDetails} ----\n`,
  );
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
  desktopLogSink: RotatingFileSink | null,
  runId: string,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName, runId)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

// ---------------------------------------------------------------------------
// Stdio capture
// ---------------------------------------------------------------------------

/**
 * Patches process.stdout/stderr to mirror output to `desktopLogSink`.
 *
 * Returns a restore function, or `null` if capture was not installed (already
 * active, not packaged, or sink missing).
 */
export function installStdIoCapture(
  desktopLogSink: RotatingFileSink | null,
  runId: string,
  alreadyActive: boolean,
): (() => void) | null {
  if (!app.isPackaged || desktopLogSink === null || alreadyActive) {
    return null;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding, desktopLogSink, runId);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  return () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  };
}

// ---------------------------------------------------------------------------
// Packaged logging initialisation
// ---------------------------------------------------------------------------

interface PackagedLoggingResult {
  readonly desktopLogSink: RotatingFileSink | null;
  readonly backendLogSink: RotatingFileSink | null;
  /** Call this to undo the stdio patch, or `null` if capture wasn't installed. */
  readonly restoreStdIoCapture: (() => void) | null;
}

/**
 * Creates rotating file sinks and installs stdio capture for packaged builds.
 *
 * Safe to call in all environments — returns `null` sinks in dev.
 */
export function initializePackagedLogging(
  logDir: string,
  logFileMaxBytes: number,
  logFileMaxFiles: number,
  runId: string,
): PackagedLoggingResult {
  if (!app.isPackaged) {
    return { desktopLogSink: null, backendLogSink: null, restoreStdIoCapture: null };
  }

  try {
    const desktopLogSink = new RotatingFileSink({
      filePath: Path.join(logDir, "desktop-main.log"),
      maxBytes: logFileMaxBytes,
      maxFiles: logFileMaxFiles,
    });
    const backendLogSink = new RotatingFileSink({
      filePath: Path.join(logDir, "server-child.log"),
      maxBytes: logFileMaxBytes,
      maxFiles: logFileMaxFiles,
    });
    const restoreStdIoCapture = installStdIoCapture(desktopLogSink, runId, false);
    writeDesktopLogHeader(`runtime log capture enabled logDir=${logDir}`, desktopLogSink, runId);
    return { desktopLogSink, backendLogSink, restoreStdIoCapture };
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
    return { desktopLogSink: null, backendLogSink: null, restoreStdIoCapture: null };
  }
}

// ---------------------------------------------------------------------------
// Backend output capture
// ---------------------------------------------------------------------------

/** Pipes child stdout/stderr into `backendLogSink` (packaged builds only). */
export function captureBackendOutput(
  child: ChildProcess.ChildProcess,
  backendLogSink: RotatingFileSink | null,
): void {
  if (!app.isPackaged || backendLogSink === null) return;
  const writeChunk = (chunk: unknown): void => {
    if (!backendLogSink) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    backendLogSink.write(buffer);
  };
  child.stdout?.on("data", writeChunk);
  child.stderr?.on("data", writeChunk);
}
