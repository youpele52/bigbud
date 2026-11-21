import { beforeEach, describe, expect, it, vi } from "vitest";

const listDirectory = vi.hoisted(() => vi.fn());
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { listDirectory } }),
}));

import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { openPathFromChat } from "../../stores/files/filesPanel.open";
import {
  createFilesPanelWorkspaceKey,
  resolveFilesPanelWorkspaceRootOverride,
} from "./FilesPanel.workspace";
import { checkFileExists } from "./useFilesPanelHistory";

const CURRENT_ROOT = "/work/current";

/** The Files panel's own composition: request root → active root → history key → preview. */
function consumeOpenRequest(currentRoot = CURRENT_ROOT, currentTarget = "local") {
  const state = useFilesPanelStore.getState();
  const override = resolveFilesPanelWorkspaceRootOverride({
    requestedRoot: state.workspaceRootOverride,
    requestedExecutionTargetId: state.workspaceExecutionTargetIdOverride,
    workspaceRoot: currentRoot,
    workspaceExecutionTargetId: currentTarget,
  });
  const root = override ?? currentRoot;
  // Mirrors `activeWorkspaceExecutionTargetId` in FilesPanel.tsx.
  const target =
    override === null
      ? (state.workspaceExecutionTargetIdOverride ?? currentTarget)
      : (state.workspaceExecutionTargetIdOverride ?? "local");
  const key = createFilesPanelWorkspaceKey({
    ...(override === null ? { projectId: "current" } : {}),
    workspaceRoot: root,
    executionTargetId: target,
  });
  state.setWorkspaceKey(key);
  const request = useFilesPanelStore.getState().fileOpenRequest!;
  useFilesPanelStore
    .getState()
    .openPreview({ path: request.path, position: null, scrollTop: null });
  return { key, root, target, path: request.path };
}

describe("opening files outside the current project", () => {
  beforeEach(() => {
    listDirectory.mockReset();
    useFilesPanelStore.setState({
      workspaceRootOverride: null,
      workspaceExecutionTargetIdOverride: null,
      fileOpenRequest: null,
      workspaceKey: null,
      histories: {},
      historyKeys: [],
    });
  });

  it.each([
    ["another project's file (search row)", "/work/other/src/a.ts", "/work/other", "/work/other"],
    [
      "a file outside every project",
      "/Users/me/Documents/notes.md",
      CURRENT_ROOT,
      "/Users/me/Documents",
    ],
  ])("records %s under its own absolute root and never prunes it", async (_, file, root, owner) => {
    await openPathFromChat(file, root);
    const opened = consumeOpenRequest();
    expect(opened.root).toBe(owner);
    expect(`${opened.root}/${opened.path}`).toBe(file);

    // The history check lists the file's own folder, never the current project.
    const parent = opened.path.includes("/")
      ? opened.path.slice(0, opened.path.lastIndexOf("/"))
      : "";
    listDirectory.mockResolvedValue({ entries: [{ path: opened.path, kind: "file" }] });
    await expect(checkFileExists(opened.root, opened.path, undefined)).resolves.toBe("exists");
    expect(listDirectory).toHaveBeenCalledWith({
      cwd: owner,
      ...(parent ? { relativePath: parent } : {}),
    });
    expect(listDirectory.mock.calls.some(([input]) => input.cwd === CURRENT_ROOT)).toBe(false);

    const history = useFilesPanelStore.getState().histories[opened.key];
    expect(history?.entries.map((entry) => entry.path)).toEqual([opened.path]);
    // Nothing leaked into the current project's history, where it would look missing.
    const currentKey = createFilesPanelWorkspaceKey({
      projectId: "current",
      workspaceRoot: CURRENT_ROOT,
      executionTargetId: "local",
    });
    expect(useFilesPanelStore.getState().histories[currentKey]).toBeUndefined();
  });

  it("keeps a current-project file in the project's own history", async () => {
    await openPathFromChat(`${CURRENT_ROOT}/src/b.ts`, CURRENT_ROOT);
    const opened = consumeOpenRequest();
    expect(opened).toMatchObject({ root: CURRENT_ROOT, path: "src/b.ts" });
    expect(opened.key).toBe(`project:current:${CURRENT_ROOT}::local`);
  });

  it("opens another remote project's file on its own target and root, never pruned", async () => {
    const remote = "ssh:host=box&transport=agent";
    await openPathFromChat("/srv/other/src/a.ts", "/srv/other", "file", remote as never);
    const opened = consumeOpenRequest("/srv/current", remote);
    expect(opened).toMatchObject({ root: "/srv/other", target: remote, path: "src/a.ts" });
    expect(opened.key).toBe(`chat:/srv/other::${remote}`);

    listDirectory.mockResolvedValue({ entries: [{ path: "src/a.ts", kind: "file" }] });
    await expect(checkFileExists(opened.root, opened.path, remote)).resolves.toBe("exists");
    expect(listDirectory).toHaveBeenCalledWith({
      cwd: "/srv/other",
      executionTargetId: remote,
      relativePath: "src",
    });
    expect(useFilesPanelStore.getState().histories[opened.key]?.entries).toHaveLength(1);
  });

  it("never merges the same folder path on different targets", async () => {
    await openPathFromChat("/srv/current/a.ts", "/srv/current", "file", "local" as never);
    const opened = consumeOpenRequest("/srv/current", "ssh:vps");
    expect(opened).toMatchObject({ root: "/srv/current", target: "local" });
    expect(opened.key).toBe("chat:/srv/current::local");
  });
});
