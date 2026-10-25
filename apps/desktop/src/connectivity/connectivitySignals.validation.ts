import type {
  DesktopConnectivitySignal,
  DesktopConnectivitySignalKind,
} from "@bigbud/contracts/server/ipc.desktop.ts";

const SIGNAL_KINDS: ReadonlySet<DesktopConnectivitySignalKind> = new Set([
  "suspend",
  "resume",
  "lock-screen",
  "unlock-screen",
  "online",
  "offline",
]);

/** Validates IPC payloads in the isolated preload before they reach the renderer. */
export function isDesktopConnectivitySignal(value: unknown): value is DesktopConnectivitySignal {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  return (
    typeof signal.kind === "string" &&
    SIGNAL_KINDS.has(signal.kind as DesktopConnectivitySignalKind) &&
    typeof signal.sequence === "number" &&
    Number.isSafeInteger(signal.sequence) &&
    typeof signal.occurredAt === "number" &&
    Number.isFinite(signal.occurredAt) &&
    (signal.online === null || typeof signal.online === "boolean")
  );
}
