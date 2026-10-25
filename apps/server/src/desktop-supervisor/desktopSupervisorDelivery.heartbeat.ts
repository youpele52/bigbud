import type { DesktopSupervisorOwner } from "./desktopSupervisorDelivery.types.ts";
import type { DesktopSupervisorFrame } from "./desktopSupervisorProtocol.ts";

export type DesktopSupervisorHeartbeatEcho = Extract<DesktopSupervisorFrame, { type: "heartbeat" }>;

/**
 * Sends a heartbeat every `intervalMs` while a supervisor client is attached. Each echo goes to
 * `onEcho`; protocol 1.4 supervisors fill in the machine's total suspended time there. A failed
 * heartbeat invalidates that client.
 */
export function startDesktopSupervisorHeartbeat(input: {
  readonly intervalMs: number;
  readonly getClient: () => DesktopSupervisorOwner | null;
  readonly isClosed: () => boolean;
  readonly onFailure: (cause: unknown, client: DesktopSupervisorOwner) => void;
  readonly onEcho: (echo: DesktopSupervisorHeartbeatEcho) => void;
}): ReturnType<typeof setInterval> {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const client = input.getClient();
    if (!client || input.isClosed()) return;
    void client.heartbeat(Date.now() - startedAt).then(
      (frame) => {
        if (frame.type === "heartbeat") input.onEcho(frame);
      },
      (cause: unknown) => input.onFailure(cause, client),
    );
  }, input.intervalMs);
  timer.unref?.();
  return timer;
}
