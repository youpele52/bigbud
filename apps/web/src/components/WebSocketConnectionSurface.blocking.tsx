import { AlertTriangle, CloudOff, LoaderCircle, RotateCw } from "lucide-react";

import { APP_DISPLAY_NAME, APP_SERVER_NAME } from "../config/branding";
import { type WsConnectionStatus, type WsConnectionUiState } from "../rpc/wsConnectionState";
import { Button } from "./ui/button";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";

const connectionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  second: "2-digit",
});

export function formatConnectionMoment(isoDate: string | null): string | null {
  if (!isoDate) {
    return null;
  }

  return connectionTimeFormatter.format(new Date(isoDate));
}

function buildBlockingCopy(
  uiState: WsConnectionUiState,
  status: WsConnectionStatus,
): {
  readonly description: string;
  readonly eyebrow: string;
  readonly title: string;
} {
  if (uiState === "connecting") {
    return {
      description: `Opening the WebSocket connection to the ${APP_DISPLAY_NAME} server and waiting for the initial config snapshot.`,
      eyebrow: "Starting Session",
      title: `Connecting to ${APP_DISPLAY_NAME}`,
    };
  }

  if (uiState === "offline") {
    return {
      description: `Your browser is offline, so the web client cannot reach the ${APP_SERVER_NAME}. Reconnect to the network and the app will retry automatically.`,
      eyebrow: "Offline",
      title: "WebSocket connection unavailable",
    };
  }

  if (status.lastError?.trim()) {
    return {
      description: `${status.lastError} Verify that the ${APP_SERVER_NAME} is running and reachable, then reload the app if needed.`,
      eyebrow: "Connection Error",
      title: `Cannot reach the ${APP_SERVER_NAME}`,
    };
  }

  return {
    description: `The web client could not complete its initial WebSocket connection to the ${APP_SERVER_NAME}. It will keep retrying in the background.`,
    eyebrow: "Connection Error",
    title: `Cannot reach the ${APP_SERVER_NAME}`,
  };
}

function buildConnectionDetails(status: WsConnectionStatus, uiState: WsConnectionUiState): string {
  const details = [
    `state: ${uiState}`,
    `online: ${status.online ? "yes" : "no"}`,
    `attempts: ${status.attemptCount}`,
  ];

  if (status.socketUrl) {
    details.push(`socket: ${status.socketUrl}`);
  }
  if (status.connectedAt) {
    details.push(`connectedAt: ${status.connectedAt}`);
  }
  if (status.disconnectedAt) {
    details.push(`disconnectedAt: ${status.disconnectedAt}`);
  }
  if (status.lastErrorAt) {
    details.push(`lastErrorAt: ${status.lastErrorAt}`);
  }
  if (status.lastError) {
    details.push(`lastError: ${status.lastError}`);
  }
  if (status.closeCode !== null) {
    details.push(`closeCode: ${status.closeCode}`);
  }
  if (status.closeReason) {
    details.push(`closeReason: ${status.closeReason}`);
  }

  return details.join("\n");
}

const startupFailureCopy = {
  bootstrap_failed: "The local startup configuration could not be applied.",
  child_exit_before_ready: "The local backend stopped before it was ready.",
  child_spawn_failed: "The local backend process could not be started.",
  projection_database_initialization_failed: "Local data could not be initialized.",
  server_entry_missing: "The local backend installation is incomplete.",
  server_runtime_startup_failed: "The local backend could not finish starting.",
  startup_timed_out: "The local backend is taking longer than expected to start.",
  unknown: "The local backend could not finish starting.",
} as const;

export function getDesktopStartupFailureDescription(startup: DesktopBackendStartupState): string {
  return startupFailureCopy[
    startup.failureReason ?? (startup.status === "timedOut" ? "startup_timed_out" : "unknown")
  ];
}

export function buildStartupTechnicalDetails(startup: DesktopBackendStartupState): string | null {
  const diagnostics = startup.diagnostics;
  if (
    (startup.status !== "failed" && startup.status !== "timedOut") ||
    !startup.failureReason ||
    !diagnostics
  ) {
    return null;
  }
  return [
    `reason: ${startup.failureReason}`,
    `category: ${diagnostics.category}`,
    `occurredAt: ${diagnostics.occurredAt}`,
    ...(diagnostics.errorMessage ? [`error: ${diagnostics.errorMessage}`] : []),
    ...(diagnostics.exitCode !== undefined ? [`exitCode: ${diagnostics.exitCode}`] : []),
    ...(diagnostics.exitSignal ? [`exitSignal: ${diagnostics.exitSignal}`] : []),
    ...(diagnostics.stderrTail ? [`stderr:\n${diagnostics.stderrTail}`] : []),
    ...(startup.developmentDiagnostics
      ? [
          "development crash context:",
          `startedAt: ${new Date(startup.startedAt).toISOString()}`,
          `capturedAt: ${startup.developmentDiagnostics.capturedAt}`,
          ...(startup.developmentDiagnostics.errorName
            ? [`errorName: ${startup.developmentDiagnostics.errorName}`]
            : []),
          ...(startup.developmentDiagnostics.errorMessage
            ? [`errorMessage: ${startup.developmentDiagnostics.errorMessage}`]
            : []),
          ...(startup.developmentDiagnostics.errorCause
            ? [`errorCause: ${startup.developmentDiagnostics.errorCause}`]
            : []),
          ...(startup.developmentDiagnostics.errorStack
            ? [`errorStack:\n${startup.developmentDiagnostics.errorStack}`]
            : []),
          ...(startup.developmentDiagnostics.exitCode !== undefined
            ? [`exitCode: ${startup.developmentDiagnostics.exitCode}`]
            : []),
          ...(startup.developmentDiagnostics.exitSignal
            ? [`exitSignal: ${startup.developmentDiagnostics.exitSignal}`]
            : []),
          ...(startup.developmentDiagnostics.stderrTail
            ? [`stderr:\n${startup.developmentDiagnostics.stderrTail}`]
            : []),
        ]
      : []),
  ].join("\n");
}

export function WebSocketBlockingState({
  status,
  uiState,
  desktopStartup,
}: {
  readonly status: WsConnectionStatus;
  readonly uiState: WsConnectionUiState;
  readonly desktopStartup: DesktopBackendStartupState | null;
}) {
  const technicalDetails = desktopStartup ? buildStartupTechnicalDetails(desktopStartup) : null;
  const copy =
    desktopStartup?.status === "failed"
      ? {
          description: `${getDesktopStartupFailureDescription(desktopStartup)} Reload the app to try again.`,
          eyebrow: "Startup Failed",
          title: "Local backend stopped during startup",
        }
      : desktopStartup?.status === "timedOut"
        ? {
            description: `${getDesktopStartupFailureDescription(desktopStartup)} bigbud will reconnect automatically if it becomes ready.`,
            eyebrow: "Startup Timed Out",
            title: "Local backend startup is taking too long",
          }
        : desktopStartup?.status === "upgrading"
          ? {
              description: "Upgrading local data, please wait",
              eyebrow: "Starting Session",
              title: "Upgrading local data, please wait",
            }
          : desktopStartup?.status === "starting"
            ? {
                description: "Starting bigbud",
                eyebrow: "Starting Session",
                title: "Starting bigbud",
              }
            : buildBlockingCopy(uiState, status);
  const disconnectedAt = formatConnectionMoment(status.disconnectedAt ?? status.lastErrorAt);
  const Icon =
    desktopStartup?.status === "failed" || desktopStartup?.status === "timedOut"
      ? AlertTriangle
      : uiState === "connecting"
        ? LoaderCircle
        : uiState === "offline"
          ? CloudOff
          : AlertTriangle;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-90">
        <div className="absolute inset-x-0 top-0 h-56 bg-[radial-gradient(48rem_18rem_at_top,color-mix(in_srgb,var(--color-amber-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_92%,var(--color-black))_0%,var(--background)_56%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-[1.75rem] border border-border/80 bg-card/92 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
              {copy.eyebrow}
            </p>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{copy.title}</h1>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 p-3 text-foreground shadow-sm">
            <Icon
              className={
                uiState === "connecting" &&
                desktopStartup?.status !== "failed" &&
                desktopStartup?.status !== "timedOut"
                  ? "size-5 animate-spin"
                  : "size-5"
              }
            />
          </div>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.description}</p>

        <div className="mt-5 grid gap-3 rounded-2xl border border-border/70 bg-background/60 p-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              Connection
            </p>
            <p className="mt-1 font-medium text-foreground">
              {uiState === "connecting"
                ? "Opening WebSocket"
                : uiState === "offline"
                  ? "Waiting for network"
                  : "Retrying server connection"}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              Latest Event
            </p>
            <p className="mt-1 font-medium text-foreground">{disconnectedAt ?? "Pending"}</p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>
            <RotateCw />
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show connection details</span>
            <span className="hidden group-open:inline">Hide connection details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {buildConnectionDetails(status, uiState)}
          </pre>
        </details>
        {technicalDetails ? (
          <details className="group mt-3 overflow-hidden rounded-lg border border-border/70 bg-background/55">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
              <span className="group-open:hidden">Show technical details</span>
              <span className="hidden group-open:inline">Hide technical details</span>
            </summary>
            <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
              {technicalDetails}
            </pre>
          </details>
        ) : null}
      </section>
    </div>
  );
}
