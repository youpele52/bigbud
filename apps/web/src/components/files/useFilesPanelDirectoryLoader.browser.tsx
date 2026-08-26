import { createRef, forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ listDirectory: vi.fn() }));

vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { listDirectory: mocks.listDirectory } }),
}));

import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { pruneRemovedPaths } from "./FilesPanel.pathState";
import { useFilesPanelDirectoryLoader } from "./useFilesPanelDirectoryLoader";

interface LoaderHarnessProps {
  readonly workspaceKey: string;
  readonly workspaceRoot: string;
  readonly initialExpandedPaths?: ReadonlyArray<string>;
}

interface LoaderHarnessHandle {
  readonly loadDirectory: (
    relativePath: string,
    options?: { readonly force?: boolean },
  ) => Promise<void>;
  readonly getDirectoryPaths: () => string[];
  readonly getExpandedPaths: () => string[];
}

const LoaderHarness = forwardRef<LoaderHarnessHandle, LoaderHarnessProps>(function LoaderHarness(
  { workspaceKey, workspaceRoot, initialExpandedPaths = [] },
  ref,
) {
  const previewPath = useFilesPanelStore((state) => state.previewPath);
  const previewPosition = useFilesPanelStore((state) => state.previewPosition);
  const setPreviewPath = useFilesPanelStore((state) => state.setPreviewPath);
  const setPreviewPosition = useFilesPanelStore((state) => state.setPreviewPosition);
  const previewPathRef = useRef(previewPath);
  const previewPositionRef = useRef(previewPosition);
  previewPathRef.current = previewPath;
  previewPositionRef.current = previewPosition;
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialExpandedPaths.map((path) => [path, true])),
  );
  const onEntriesRemoved = useCallback(
    (paths: ReadonlyArray<string>) => {
      setExpandedPaths((current) => pruneRemovedPaths(current, paths));
      useFilesPanelStore.getState().removeHistoryPaths(workspaceKey, paths);
    },
    [workspaceKey],
  );
  const { directoryStateByPath, loadDirectory } = useFilesPanelDirectoryLoader({
    workspaceRoot,
    previewPathRef,
    previewPositionRef,
    setPreviewPath,
    setPreviewPosition,
    onEntriesRemoved,
    workspaceKey,
  });

  useImperativeHandle(
    ref,
    () => ({
      loadDirectory,
      getDirectoryPaths: () => Object.keys(directoryStateByPath).toSorted(),
      getExpandedPaths: () =>
        Object.entries(expandedPaths)
          .filter(([, expanded]) => expanded)
          .map(([path]) => path)
          .toSorted(),
    }),
    [directoryStateByPath, expandedPaths, loadDirectory],
  );

  return null;
});

function resetFilesPanelStore() {
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

describe("useFilesPanelDirectoryLoader lifecycle", () => {
  beforeEach(() => {
    mocks.listDirectory.mockReset();
    resetFilesPanelStore();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not expose directory state from the previous workspace", async () => {
    mocks.listDirectory.mockImplementation(
      async ({ cwd, relativePath }: { readonly cwd: string; readonly relativePath?: string }) => {
        if (cwd === "/project-a" && relativePath === undefined) {
          return { entries: [{ path: "workspace", kind: "directory" }] };
        }
        if (cwd === "/project-a" && relativePath === "workspace") {
          return { entries: [] };
        }
        if (cwd === "/project-b" && relativePath === undefined) {
          return { entries: [{ path: "docs", kind: "directory" }] };
        }
        throw new Error(`Unexpected directory request: ${cwd}:${relativePath ?? ""}`);
      },
    );
    const loaderRef = createRef<LoaderHarnessHandle>();
    const screen = await render(
      <LoaderHarness ref={loaderRef} workspaceKey="project-a" workspaceRoot="/project-a" />,
    );

    await loaderRef.current?.loadDirectory("");
    await loaderRef.current?.loadDirectory("workspace");
    await vi.waitFor(() =>
      expect(loaderRef.current?.getDirectoryPaths()).toEqual(["", "workspace"]),
    );

    await screen.rerender(
      <LoaderHarness ref={loaderRef} workspaceKey="project-b" workspaceRoot="/project-b" />,
    );
    expect(loaderRef.current?.getDirectoryPaths()).toEqual([]);

    await loaderRef.current?.loadDirectory("");
    await vi.waitFor(() => expect(loaderRef.current?.getDirectoryPaths()).toEqual([""]));
  });

  it("prunes removed descendants, expansion state, preview, and history", async () => {
    useFilesPanelStore.getState().setWorkspaceKey("project-a");
    useFilesPanelStore.getState().openPreview({
      path: "docs/api/client.ts",
      position: null,
      scrollTop: null,
    });
    let docsLoadCount = 0;
    mocks.listDirectory.mockImplementation(
      async ({ relativePath }: { readonly relativePath?: string }) => {
        if (relativePath === "docs") {
          docsLoadCount += 1;
          return docsLoadCount === 1
            ? {
                entries: [
                  { path: "docs/api", kind: "directory", parentPath: "docs" },
                  { path: "docs/readme.md", kind: "file", parentPath: "docs" },
                ],
              }
            : { entries: [] };
        }
        if (relativePath === "docs/api") {
          return {
            entries: [{ path: "docs/api/client.ts", kind: "file", parentPath: "docs/api" }],
          };
        }
        throw new Error(`Unexpected directory request: ${relativePath ?? ""}`);
      },
    );
    const loaderRef = createRef<LoaderHarnessHandle>();
    await render(
      <LoaderHarness
        ref={loaderRef}
        workspaceKey="project-a"
        workspaceRoot="/project-a"
        initialExpandedPaths={["docs/api"]}
      />,
    );

    await loaderRef.current?.loadDirectory("docs");
    await loaderRef.current?.loadDirectory("docs/api");
    await vi.waitFor(() =>
      expect(loaderRef.current?.getDirectoryPaths()).toEqual(["docs", "docs/api"]),
    );
    await loaderRef.current?.loadDirectory("docs", { force: true });

    await vi.waitFor(() => {
      expect(loaderRef.current?.getDirectoryPaths()).toEqual(["docs"]);
      expect(loaderRef.current?.getExpandedPaths()).toEqual([]);
      expect(useFilesPanelStore.getState().previewPath).toBeNull();
      expect(useFilesPanelStore.getState().histories["project-a"]?.entries).toEqual([]);
    });
  });
});
