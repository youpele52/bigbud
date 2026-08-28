import type { WsConnectionStatus } from "../rpc/wsConnectionState";

export const DRAFT_OWNERSHIP_REPAIR_BY_RENDERER = {
  main: true,
  compact: false,
} as const;

export function getDraftOwnershipRepairConnection(input: {
  readonly bootstrapComplete: boolean;
  readonly connection: Pick<WsConnectionStatus, "connectedAt" | "phase">;
  readonly lastRepairConnection: string | null;
  readonly repairOnStartup: boolean;
}): string | null {
  if (
    !input.repairOnStartup ||
    !input.bootstrapComplete ||
    input.connection.phase !== "connected"
  ) {
    return null;
  }
  const connection = input.connection.connectedAt ?? "initial-connected";
  return input.lastRepairConnection === connection ? null : connection;
}
