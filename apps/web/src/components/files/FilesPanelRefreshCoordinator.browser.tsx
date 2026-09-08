import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ProjectDirectoryWatchEvent } from "@bigbud/contracts/workspace/project";

const mocks = vi.hoisted(() => ({
  callbacks: new Map<string, (event: ProjectDirectoryWatchEvent) => void>(),
  errors: new Map<string, (error: unknown) => void>(),
  subscribe: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    projects: {
      onDirectoryChange: (
        input: { readonly relativePath?: string },
        callback: (event: ProjectDirectoryWatchEvent) => void,
        options: { readonly onError?: (error: unknown) => void },
      ) => {
        const path = input.relativePath ?? "";
        mocks.subscribe(path);
        mocks.callbacks.set(path, callback);
        if (options.onError) mocks.errors.set(path, options.onError);
        return () => {
          mocks.callbacks.delete(path);
          mocks.errors.delete(path);
        };
      },
    },
  }),
}));
vi.mock("../../rpc/serverState", () => ({ useServerConfig: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

import {
  FilesPanelRefreshCoordinator,
  useFilesPanelRefreshContext,
} from "./FilesPanelRefreshCoordinator";

const directoryState = {
  "": {
    entries: [
      { path: "docs", kind: "directory" as const },
      { path: "src", kind: "directory" as const },
    ],
    loading: false,
    error: null,
  },
  docs: { entries: [], loading: false, error: null },
  src: { entries: [], loading: false, error: null },
};

function PreviewRegistration({ refresh }: { readonly refresh: () => Promise<void> }) {
  const context = useFilesPanelRefreshContext();
  useEffect(
    () =>
      context?.registerPreview({
        cwd: "/project",
        relativePath: "docs/readme.md",
        refreshPreview: refresh,
      }),
    [context, refresh],
  );
  return null;
}

function rescan(): ProjectDirectoryWatchEvent {
  return {
    version: 2,
    type: "rescanRequired",
    relativePath: "docs",
    generation: 2,
    sequence: 1,
    reason: "watchInvalidated",
    backend: "native",
  };
}

interface CoordinatorInput {
  readonly refresh: () => Promise<void>;
  readonly loadDirectory: (path: string) => Promise<void>;
  readonly previewPath?: string;
  readonly directoryStateByPath?: typeof directoryState;
}

function coordinatorView(input: CoordinatorInput) {
  return (
    <FilesPanelRefreshCoordinator
      workspaceRoot="/project"
      previewPath={input.previewPath ?? "docs/readme.md"}
      expandedDirectories={{ docs: true, src: true }}
      directoryStateByPath={input.directoryStateByPath ?? directoryState}
      loadDirectory={input.loadDirectory}
    >
      <PreviewRegistration refresh={input.refresh} />
    </FilesPanelRefreshCoordinator>
  );
}

async function renderCoordinator(input: CoordinatorInput) {
  return render(coordinatorView(input));
}

describe("FilesPanelRefreshCoordinator integration", () => {
  afterEach(() => {
    mocks.callbacks.clear();
    mocks.errors.clear();
    mocks.subscribe.mockClear();
    mocks.toast.mockClear();
    document.body.innerHTML = "";
  });

  it("awaits preview before parent, root, and remaining directories", async () => {
    const order: string[] = [];
    let releasePreview: (() => void) | undefined;
    const preview = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    await renderCoordinator({
      refresh: async () => {
        order.push("preview-start");
        await preview;
        order.push("preview-end");
      },
      loadDirectory: async (path) => {
        order.push(path || "root");
      },
    });
    await vi.waitFor(() => expect(mocks.callbacks.has("docs")).toBe(true));

    mocks.callbacks.get("docs")!(rescan());
    await vi.waitFor(() => expect(order).toEqual(["preview-start"]));
    releasePreview?.();
    await vi.waitFor(() =>
      expect(order).toEqual(["preview-start", "preview-end", "docs", "root", "src"]),
    );
  });

  it("deduplicates queued events and never overlaps preview reloads", async () => {
    let inFlight = 0;
    let maximumInFlight = 0;
    let refreshes = 0;
    let releasePreview: (() => void) | undefined;
    const makePreview = () =>
      new Promise<void>((resolve) => {
        releasePreview = resolve;
      });
    let preview = makePreview();
    await renderCoordinator({
      refresh: async () => {
        refreshes += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await preview;
        inFlight -= 1;
        preview = makePreview();
      },
      loadDirectory: async () => {},
    });
    await vi.waitFor(() => expect(mocks.callbacks.has("docs")).toBe(true));

    mocks.callbacks.get("docs")!(rescan());
    mocks.callbacks.get("docs")!(rescan());
    await vi.waitFor(() => expect(refreshes).toBe(1));
    mocks.callbacks.get("docs")!(rescan());
    mocks.callbacks.get("docs")!(rescan());
    expect(maximumInFlight).toBe(1);

    releasePreview?.();
    await vi.waitFor(() => expect(refreshes).toBe(2));
    expect(maximumInFlight).toBe(1);
    releasePreview?.();
  });

  it("surfaces a non-retryable watcher availability failure once", async () => {
    await renderCoordinator({ refresh: async () => {}, loadDirectory: async () => {} });
    await vi.waitFor(() => expect(mocks.errors.has("docs")).toBe(true));

    const error = new Error("Native workspace watcher is incompatible with this architecture.");
    mocks.errors.get("docs")!(error);
    mocks.errors.get("")!(error);

    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Automatic file refresh unavailable",
      description: error.message,
    });
  });

  it("keeps equivalent path subscriptions stable across directory state updates", async () => {
    const input = { refresh: async () => {}, loadDirectory: async () => {} };
    const screen = await renderCoordinator(input);
    await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(3));

    await screen.rerender(
      coordinatorView({ ...input, directoryStateByPath: { ...directoryState } }),
    );

    expect(mocks.subscribe).toHaveBeenCalledTimes(3);
  });

  it("deduplicates availability failures across effect generations in one workspace", async () => {
    const input = { refresh: async () => {}, loadDirectory: async () => {} };
    const screen = await renderCoordinator(input);
    await vi.waitFor(() => expect(mocks.errors.has("docs")).toBe(true));
    const error = new Error("Native workspace watcher is unavailable.");
    mocks.errors.get("docs")!(error);
    expect(mocks.toast).toHaveBeenCalledOnce();

    await screen.rerender(coordinatorView({ ...input, previewPath: "docs/other.md" }));
    await vi.waitFor(() => expect(mocks.errors.has("")).toBe(true));
    mocks.errors.get("")!(error);

    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("reconciles a vanished child through its parent without a global error toast", async () => {
    const loadDirectory = vi.fn(async () => {});
    await renderCoordinator({ refresh: async () => {}, loadDirectory });
    await vi.waitFor(() => expect(mocks.errors.has("docs")).toBe(true));

    mocks.errors.get("docs")!(new Error("NOT_FOUND: workspace path was not found: docs"));

    await vi.waitFor(() => expect(loadDirectory).toHaveBeenCalledWith("", { force: true }));
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
