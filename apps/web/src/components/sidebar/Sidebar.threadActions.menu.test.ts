import { describe, expect, it } from "vitest";

import { buildRemoteTargetMenuItems } from "../../lib/remoteTargetMenu";
import {
  buildThreadContextMenuItems,
  resolveThreadElevatorSummary,
} from "./Sidebar.threadActions.menu";

const thread = {
  title: "Fix login",
  elevatorSummary: null,
  pinnedAt: null,
  organization: undefined,
};
const ids = (items: ReturnType<typeof buildThreadContextMenuItems>) =>
  items.filter((item) => !item.separator && !item.children).map((item) => item.id);

describe("thread context menu", () => {
  it("puts Reconnect and Disconnect in their own section above Delete for SSH-workspace threads", () => {
    const items = buildThreadContextMenuItems({
      thread,
      remoteItems: buildRemoteTargetMenuItems({
        executionTargetId: "ssh:host=ice-2-kg&auth=password",
        disconnected: false,
        reconnectPending: false,
      }),
    });
    expect(ids(items).slice(-6)).toEqual([
      "copy-thread-id",
      "copy-path",
      "archive",
      "reconnect",
      "disconnect",
      "delete",
    ]);
    const archive = items.findIndex((item) => item.id === "archive");
    expect(items.slice(archive + 1).map((item) => item.id)).toEqual([
      "separator-remote",
      "reconnect",
      "disconnect",
      "separator-delete",
      "delete",
    ]);
  });

  it("shows Connect alone above Delete when the workspace is disconnected", () => {
    const items = buildThreadContextMenuItems({
      thread,
      remoteItems: buildRemoteTargetMenuItems({
        executionTargetId: "ssh:host=ice-2-kg&auth=password",
        disconnected: true,
        reconnectPending: false,
      }),
    });
    expect(ids(items).slice(-3)).toEqual(["archive", "connect", "delete"]);
    const archive = items.findIndex((item) => item.id === "archive");
    expect(items.slice(archive + 1).map((item) => item.id)).toEqual([
      "separator-remote",
      "connect",
      "separator-delete",
      "delete",
    ]);
  });

  it("adds no remote items for local threads", () => {
    const items = buildThreadContextMenuItems({ thread, remoteItems: [] });
    expect(ids(items).slice(-2)).toEqual(["archive", "delete"]);
    expect(items.some((item) => item.id === "separator-remote")).toBe(false);
    expect(items.some((item) => item.id === "reconnect")).toBe(false);
  });

  it("offers the elevator summary only when it says more than the title", () => {
    expect(resolveThreadElevatorSummary({ title: "A", elevatorSummary: "  A " })).toBeNull();
    expect(resolveThreadElevatorSummary({ title: "A", elevatorSummary: " More  detail " })).toBe(
      "More detail",
    );
  });
});
