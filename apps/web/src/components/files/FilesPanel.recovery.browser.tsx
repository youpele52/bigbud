import "../../index.css";

import { createRef, forwardRef, StrictMode, useEffect, useImperativeHandle, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ listDirectory: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ projects: { listDirectory: mocks.listDirectory } }),
}));

import { renderFilesPanelTreeBody } from "./FilesPanel.body";
import { useFilesPanelDirectoryLoader } from "./useFilesPanelDirectoryLoader";

type Loader = ReturnType<typeof useFilesPanelDirectoryLoader>;
const Harness = forwardRef<Pick<Loader, "loadDirectory">, { root?: string }>(function Harness(
  { root = "/srv/project" },
  ref,
) {
  const preview = useRef<string | null>("docs/readme.md");
  const position = useRef<{ line: number; column: number | null } | null>(null);
  const { directoryStateByPath, loadDirectory } = useFilesPanelDirectoryLoader({
    workspaceRoot: root,
    workspaceExecutionTargetId: "ssh:dev",
    workspaceKey: root,
    previewPathRef: preview,
    previewPositionRef: position,
    setPreviewPath: (value) => {
      preview.current = value;
    },
    setPreviewPosition: (value) => {
      position.current = value;
    },
    onEntriesRemoved: () => undefined,
  });
  useImperativeHandle(ref, () => ({ loadDirectory }), [loadDirectory]);
  const state = directoryStateByPath[""];
  return (
    <>
      <div aria-label="Preview">{preview.current}</div>
      {renderFilesPanelTreeBody({
        remote: true,
        showLoading: state?.loading,
        recovering: state?.recovering,
        requestPending: state?.requestPending,
        error: state?.error,
        entries: state?.entries ?? [],
        workspaceRoot: root,
        previewPath: preview.current,
        resolvedTheme: "dark",
        expandedDirectories: { docs: true },
        directoryStateByPath,
        onRetryDirectory: (path) => void loadDirectory(path, { force: true }),
        onToggleDirectory: () => undefined,
        onOpenFile: () => undefined,
        onOpenContextMenu: () => undefined,
      })}
    </>
  );
});

const transient = new Error(
  "mux_client_request_session: session request failed: Session open refused by peer",
);
const rootEntries = { entries: [{ path: "docs", kind: "directory" }] };
const docEntries = { entries: [{ path: "docs/readme.md", kind: "file", parentPath: "docs" }] };
async function advance(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe("remote file tree recovery", () => {
  beforeEach(() => {
    mocks.listDirectory.mockReset();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => vi.useRealTimers());

  it("keeps cached nested files and preview visible and removes the logo immediately on recovery", async () => {
    mocks.listDirectory
      .mockResolvedValueOnce(rootEntries)
      .mockResolvedValueOnce(docEntries)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(docEntries);
    const ref = createRef<Pick<Loader, "loadDirectory">>();
    await render(<Harness ref={ref} />);
    await ref.current!.loadDirectory("");
    await ref.current!.loadDirectory("docs");
    await advance();
    const file = page.getByRole("button", { name: "readme.md" });
    const originalFile = file.element();
    void ref.current!.loadDirectory("docs", { force: true });
    await advance();
    await expect.element(page.getByRole("status")).toHaveTextContent("Reconnecting to workspace…");
    await expect.element(file).toBeVisible();
    expect(file.element()).toBe(originalFile);
    await expect.element(page.getByLabelText("Preview")).toHaveTextContent("docs/readme.md");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    const logo = document.querySelector('[role="status"] svg');
    expect(logo?.getAttribute("class")).toContain("motion-reduce:animate-none");
    await advance(999);
    expect(mocks.listDirectory).toHaveBeenCalledTimes(3);
    await advance(1);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    await expect.element(file).toBeVisible();
    expect(mocks.listDirectory).toHaveBeenLastCalledWith({
      cwd: "/srv/project",
      executionTargetId: "ssh:dev",
      relativePath: "docs",
    });
  });

  it("keeps cached root and expanded child entries visible even after recovery expires", async () => {
    mocks.listDirectory
      .mockResolvedValueOnce(rootEntries)
      .mockResolvedValueOnce(docEntries)
      .mockRejectedValue(transient);
    const ref = createRef<Pick<Loader, "loadDirectory">>();
    await render(<Harness ref={ref} />);
    await ref.current!.loadDirectory("");
    await ref.current!.loadDirectory("docs");
    await advance();
    void ref.current!.loadDirectory("", { force: true });
    await advance();
    await expect.element(page.getByRole("button", { name: "readme.md" })).toBeVisible();
    await advance(30_000);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "docs" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "readme.md" })).toBeVisible();
    await expect.element(page.getByLabelText("Preview")).toHaveTextContent("docs/readme.md");
  });

  it("recovers when initial loading is triggered by an effect under StrictMode", async () => {
    mocks.listDirectory.mockRejectedValueOnce(transient).mockResolvedValue(rootEntries);
    const ref = createRef<Pick<Loader, "loadDirectory">>();
    function AutoLoad() {
      useEffect(() => {
        void ref.current!.loadDirectory("");
      }, []);
      return <Harness ref={ref} />;
    }
    await render(
      <StrictMode>
        <AutoLoad />
      </StrictMode>,
    );
    await advance(1_000);
    await expect.element(page.getByRole("button", { name: "docs" })).toBeVisible();
    expect(mocks.listDirectory).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows an actionable error only at the original deadline and supports manual Retry", async () => {
    mocks.listDirectory.mockRejectedValue(transient);
    const ref = createRef<Pick<Loader, "loadDirectory">>();
    await render(<Harness ref={ref} />);
    void ref.current!.loadDirectory("");
    await advance(29_999);
    await expect.element(page.getByRole("status")).toHaveTextContent("Reconnecting to workspace…");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain("session request failed");
    await advance(1);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeEnabled();
    const details = document.querySelector("details")!;
    expect(details.open).toBe(false);
    await page.getByText("Technical details").click();
    expect(details.open).toBe(true);
    await expect.element(page.getByText(transient.message, { exact: true })).toBeVisible();
    mocks.listDirectory.mockResolvedValue(rootEntries);
    await page.getByRole("button", { name: "Retry" }).click();
    await advance();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "docs" })).toBeVisible();
  });

  it("deduplicates hung reads and runs a queued forced refresh after late completion", async () => {
    let resolve!: (value: typeof rootEntries) => void;
    const hung = new Promise<typeof rootEntries>((done) => {
      resolve = done;
    });
    mocks.listDirectory.mockReturnValueOnce(hung).mockResolvedValue(rootEntries);
    const ref = createRef<Pick<Loader, "loadDirectory">>();
    await render(<Harness ref={ref} />);
    void ref.current!.loadDirectory("");
    await advance();
    await ref.current!.loadDirectory("", { force: true });
    await advance(30_000);
    await expect
      .element(page.getByRole("button", { name: "Waiting for connection…" }))
      .toBeDisabled();
    expect(mocks.listDirectory).toHaveBeenCalledOnce();
    resolve(rootEntries);
    await advance();
    expect(mocks.listDirectory).toHaveBeenCalledTimes(2);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "docs" })).toBeVisible();
  });

  it("ignores old-workspace completions and cancels their recovery timers", async () => {
    let resolve!: (value: typeof rootEntries) => void;
    const hung = new Promise<typeof rootEntries>((done) => {
      resolve = done;
    });
    mocks.listDirectory.mockReturnValueOnce(hung).mockResolvedValue({
      entries: [{ path: "current.md", kind: "file" }],
    });
    const ref = createRef<Pick<Loader, "loadDirectory">>();
    const mounted = await render(<Harness ref={ref} />);
    void ref.current!.loadDirectory("");
    await advance();
    await mounted.rerender(<Harness ref={ref} root="/srv/new" />);
    await advance();
    await ref.current!.loadDirectory("");
    expect(mocks.listDirectory.mock.calls).toEqual([
      [{ cwd: "/srv/project", executionTargetId: "ssh:dev" }],
      [{ cwd: "/srv/new", executionTargetId: "ssh:dev" }],
    ]);
    resolve(rootEntries);
    await advance(60_000);
    await expect.element(page.getByRole("button", { name: "current.md" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "docs" })).not.toBeInTheDocument();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.listDirectory).toHaveBeenCalledTimes(2);
  });

  it("shows authentication errors immediately instead of retrying for 30 seconds", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("Permission denied (publickey)."));
    const ref = createRef<Pick<Loader, "loadDirectory">>();
    await render(<Harness ref={ref} />);
    await ref.current!.loadDirectory("");
    await advance();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Check this workspace’s SSH authentication");
    await advance(30_000);
    expect(mocks.listDirectory).toHaveBeenCalledOnce();
  });
});
