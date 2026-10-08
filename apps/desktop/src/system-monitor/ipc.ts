import { ipcMain, type WebContents } from "electron";
import type { MonitorDemand, MonitorProcessQuery } from "@bigbud/contracts/system-monitor/types";
import { desktopIpcChannels } from "../main.channels";
import { SystemMonitorBridge } from "./bridge";

function demand(value: unknown): MonitorDemand {
  if (!value || typeof value !== "object") throw new Error("invalid monitor demand");
  const input = value as Record<string, unknown>;
  if (
    typeof input.processes !== "boolean" ||
    typeof input.disks !== "boolean" ||
    typeof input.sensors !== "boolean" ||
    (input.appResources !== undefined && typeof input.appResources !== "boolean")
  )
    throw new Error("invalid monitor demand");
  return {
    processes: input.processes,
    disks: input.disks,
    sensors: input.sensors,
    ...(input.appResources === undefined ? {} : { appResources: input.appResources as boolean }),
  };
}
function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid monitor identifier");
  return value;
}
function query(value: unknown): MonitorProcessQuery {
  if (!value || typeof value !== "object") throw new Error("invalid monitor query");
  const input = value as Record<string, unknown>;
  const sort = input.sort;
  if (sort !== "cpu" && sort !== "memory" && sort !== "name" && sort !== "pid")
    throw new Error("invalid monitor sort");
  if (
    typeof input.descending !== "boolean" ||
    typeof input.limit !== "number" ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new Error("invalid monitor query");
  for (const key of ["name", "status", "search"] as const)
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || Buffer.byteLength(input[key]) > 256)
    )
      throw new Error("invalid monitor filter");
  if (
    input.pid !== undefined &&
    (typeof input.pid !== "number" ||
      !Number.isInteger(input.pid) ||
      input.pid < 0 ||
      input.pid > 0xffffffff)
  )
    throw new Error("invalid monitor pid");
  let cursor: MonitorProcessQuery["cursor"];
  if (input.cursor !== undefined) {
    if (!input.cursor || typeof input.cursor !== "object")
      throw new Error("invalid monitor cursor");
    const c = input.cursor as Record<string, unknown>;
    if (typeof c.digest !== "string" || !/^[0-9]{1,20}$/.test(c.digest))
      throw new Error("invalid monitor cursor");
    cursor = {
      generation: id(c.generation),
      digest: c.digest,
      offset:
        typeof c.offset === "number" && Number.isSafeInteger(c.offset) && c.offset >= 0
          ? c.offset
          : -1,
    };
    if (cursor.offset < 0) throw new Error("invalid monitor cursor");
  }
  return {
    sort,
    descending: input.descending,
    limit: input.limit,
    ...(input.name === undefined ? {} : { name: input.name as string }),
    ...(input.status === undefined ? {} : { status: input.status as string }),
    ...(input.search === undefined ? {} : { search: input.search as string }),
    ...(input.pid === undefined ? {} : { pid: input.pid as number }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}
export function registerSystemMonitorIpc(
  bridge: SystemMonitorBridge,
  isMain: (sender: WebContents) => boolean,
): void {
  const owners = new Map<number, Set<number>>();
  const guard = (sender: WebContents): Set<number> => {
    if (!isMain(sender) || sender.isDestroyed()) throw new Error("monitor IPC denied");
    bridge.addRenderer(sender);
    let ids = owners.get(sender.id);
    if (!ids) {
      ids = new Set();
      owners.set(sender.id, ids);
      sender.once("destroyed", () => {
        const active = owners.get(sender.id);
        owners.delete(sender.id);
        for (const subscriptionId of active ?? []) {
          try {
            bridge.unsubscribe(subscriptionId);
          } catch {
            /* process already exited */
          }
        }
      });
    }
    return ids;
  };
  const owned = (sender: WebContents, rawId: unknown): number => {
    const subscriptionId = id(rawId);
    if (!guard(sender).has(subscriptionId)) throw new Error("monitor subscription denied");
    return subscriptionId;
  };
  ipcMain.handle(desktopIpcChannels.systemMonitorSubscribe, async (event, raw) => {
    const ids = guard(event.sender);
    const subscriptionId = await bridge.subscribe(demand(raw));
    if (event.sender.isDestroyed()) {
      bridge.unsubscribe(subscriptionId);
      throw new Error("monitor renderer destroyed");
    }
    ids.add(subscriptionId);
    return subscriptionId;
  });
  ipcMain.handle(desktopIpcChannels.systemMonitorUpdate, (event, rawId, rawDemand) => {
    bridge.update(owned(event.sender, rawId), demand(rawDemand));
  });
  ipcMain.handle(desktopIpcChannels.systemMonitorUnsubscribe, (event, rawId) => {
    const subscriptionId = owned(event.sender, rawId);
    guard(event.sender).delete(subscriptionId);
    bridge.unsubscribe(subscriptionId);
  });
  ipcMain.handle(desktopIpcChannels.systemMonitorAck, (event, rawId, rawEpoch, rawSequence) => {
    bridge.ack(owned(event.sender, rawId), id(rawEpoch), id(rawSequence));
  });
  ipcMain.handle(desktopIpcChannels.systemMonitorQuery, (event, raw) => {
    guard(event.sender);
    return bridge.query(query(raw));
  });
  ipcMain.handle(desktopIpcChannels.systemMonitorRetry, (event) => {
    guard(event.sender);
    return bridge.retry();
  });
}
