import { beforeEach, describe, expect, it } from "vitest";

import { useFilesPanelStore } from "./filesPanel.store";

const entry = (path: string) => ({ path, position: null, scrollTop: null });

function resetStore() {
  useFilesPanelStore.setState({
    workspaceKey: null,
    histories: {},
    historyKeys: [],
    previewPath: null,
    previewPosition: null,
    fileOpenRequest: null,
    directoryNavigationRequest: null,
  });
}

describe("files panel history store", () => {
  beforeEach(resetStore);

  it("keeps the preview closed without destroying history", () => {
    const store = useFilesPanelStore.getState();
    store.setWorkspaceKey("project:a::local");
    useFilesPanelStore.getState().openPreview(entry("src/a.ts"));
    useFilesPanelStore.getState().closePreview();

    expect(useFilesPanelStore.getState().previewPath).toBeNull();
    expect(useFilesPanelStore.getState().histories["project:a::local"]?.entries).toEqual([
      entry("src/a.ts"),
    ]);
  });

  it("moves history and the visible preview atomically", () => {
    useFilesPanelStore.getState().setWorkspaceKey("project:a::local");
    useFilesPanelStore.getState().openPreview(entry("src/a.ts"));
    useFilesPanelStore.getState().openPreview(entry("src/b.ts"));
    useFilesPanelStore.getState().moveHistory(-1);

    expect(useFilesPanelStore.getState().previewPath).toBe("src/a.ts");
  });

  it("removes deleted paths only from the active workspace", () => {
    useFilesPanelStore.getState().setWorkspaceKey("project:a::local");
    useFilesPanelStore.getState().openPreview(entry("src/a.ts"));
    useFilesPanelStore.getState().setWorkspaceKey("project:b::local");
    useFilesPanelStore.getState().openPreview(entry("src/a.ts"));
    useFilesPanelStore.getState().setWorkspaceKey("project:a::local");
    useFilesPanelStore.getState().removeHistoryPaths("project:a::local", ["src/a.ts"]);

    expect(useFilesPanelStore.getState().histories["project:a::local"]?.entries).toEqual([]);
    expect(useFilesPanelStore.getState().histories["project:b::local"]?.entries).toEqual([
      entry("src/a.ts"),
    ]);
  });

  it("removes files beneath a deleted or renamed directory", () => {
    useFilesPanelStore.getState().setWorkspaceKey("project:a::local");
    useFilesPanelStore.getState().openPreview(entry("src/old/a.ts"));
    useFilesPanelStore.getState().openPreview(entry("src/keep.ts"));
    useFilesPanelStore.getState().removeHistoryPaths("project:a::local", ["src/old"]);

    expect(
      useFilesPanelStore.getState().histories["project:a::local"]?.entries.map(({ path }) => path),
    ).toEqual(["src/keep.ts"]);
  });

  it("returns the number of actual history entries removed", () => {
    useFilesPanelStore.getState().setWorkspaceKey("project:a::local");
    useFilesPanelStore.getState().openPreview(entry("src/old/a.ts"));
    useFilesPanelStore.getState().openPreview(entry("src/old/b.ts"));

    expect(useFilesPanelStore.getState().removeHistoryPaths("project:a::local", ["src/old"])).toBe(
      2,
    );
    expect(
      useFilesPanelStore.getState().removeHistoryPaths("project:a::local", ["src/missing"]),
    ).toBe(0);
  });

  it("does not close another workspace preview when removing an inactive workspace history", () => {
    useFilesPanelStore.getState().setWorkspaceKey("project:a::local");
    useFilesPanelStore.getState().openPreview(entry("src/removed.ts"));
    useFilesPanelStore.getState().setWorkspaceKey("project:b::local");
    useFilesPanelStore.getState().openPreview(entry("src/current.ts"));

    useFilesPanelStore.getState().removeHistoryPaths("project:a::local", ["src/removed.ts"]);

    expect(useFilesPanelStore.getState().previewPath).toBe("src/current.ts");
    expect(useFilesPanelStore.getState().histories["project:a::local"]?.entries).toEqual([]);
  });

  it("consumes external open requests so reopening the panel does not replay them", () => {
    useFilesPanelStore.getState().requestFileOpen("src/a.ts", null, null);
    const requestId = useFilesPanelStore.getState().fileOpenRequest?.requestId;
    expect(requestId).toBeDefined();
    useFilesPanelStore.getState().consumeFileOpenRequest(requestId ?? -1);
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });
});
