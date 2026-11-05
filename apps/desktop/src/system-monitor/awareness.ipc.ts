import type { WebContents } from "electron";
import { desktopIpcChannels } from "../main.channels";
import { authorizedHandle } from "../window/ipcAuthorization";
import type { ResourceAwareness } from "./awareness";

export function registerResourceAwarenessIpc(
  owner: ResourceAwareness,
  isMain: (sender: WebContents) => boolean,
): void {
  const renderers = new Set<WebContents>();
  const guard = (sender: WebContents) => {
    if (!isMain(sender) || sender.isDestroyed()) throw new Error("monitor IPC denied");
    if (!renderers.has(sender)) {
      renderers.add(sender);
      sender.once("destroyed", () => renderers.delete(sender));
    }
  };
  authorizedHandle(desktopIpcChannels.resourceAwarenessGet, ["main"], (event) => {
    guard(event.sender);
    return owner.state();
  });
  authorizedHandle(
    desktopIpcChannels.resourceAwarenessAcknowledge,
    ["main"],
    (event, ids: unknown) => {
      guard(event.sender);
      if (
        !Array.isArray(ids) ||
        ids.length > 64 ||
        ids.some((id) => typeof id !== "string" || id.length > 1024)
      )
        throw new Error("invalid alert acknowledgement");
      owner.acknowledge(ids);
    },
  );
  authorizedHandle(
    desktopIpcChannels.resourceAwarenessMutate,
    ["main"],
    (event, mutation: unknown) => {
      guard(event.sender);
      if (Buffer.byteLength(JSON.stringify(mutation)) > 16384)
        throw new Error("monitor request too large");
      return owner.mutate(mutation, () => !event.sender.isDestroyed() && isMain(event.sender));
    },
  );
  owner.listen((state) => {
    for (const sender of renderers) {
      if (!sender.isDestroyed() && isMain(sender)) {
        try {
          sender.send(desktopIpcChannels.resourceAwarenessState, state);
        } catch {
          renderers.delete(sender);
        }
      }
    }
  });
}
