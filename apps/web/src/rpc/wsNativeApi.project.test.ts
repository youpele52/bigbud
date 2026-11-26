import type { ProjectDirectoryWatchEvent } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  emitEvent,
  projectDirectoryEventListeners,
  rpcClientMock,
} from "./wsNativeApi.test.helpers";

describe("wsNativeApi — project", () => {
  it("forwards workspace file writes to the project RPC", async () => {
    rpcClientMock.projects.writeFile.mockResolvedValue({ relativePath: "plan.md" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(rpcClientMock.projects.writeFile).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards Files create-folder, delete and entry actions to the project RPCs", async () => {
    rpcClientMock.projects.entryActions.mockResolvedValue({
      createFile: { allowed: true },
      createFolder: { allowed: true },
      delete: { allowed: true, permanent: false },
    });
    rpcClientMock.projects.createDirectory.mockResolvedValue({ relativePath: "docs" });
    rpcClientMock.projects.deleteEntry.mockResolvedValue({
      relativePath: "docs",
      disposition: "trashed",
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.entryActions({ cwd: "/tmp/project" });
    await api.projects.createDirectory({ cwd: "/tmp/project", relativePath: "docs" });
    await api.projects.deleteEntry({
      cwd: "/tmp/project",
      relativePath: "docs",
      expectedKind: "directory",
    });

    expect(rpcClientMock.projects.entryActions).toHaveBeenCalledWith({ cwd: "/tmp/project" });
    expect(rpcClientMock.projects.createDirectory).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "docs",
    });
    expect(rpcClientMock.projects.deleteEntry).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "docs",
      expectedKind: "directory",
    });
  });

  it("forwards workspace file previews to the project RPC", async () => {
    rpcClientMock.projects.readFilePreview.mockResolvedValue({
      relativePath: "plan.md",
      contents: "# Plan\n",
      sizeBytes: 7,
      truncated: false,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.readFilePreview({
      cwd: "/tmp/project",
      relativePath: "plan.md",
    });

    expect(rpcClientMock.projects.readFilePreview).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "plan.md",
    });
  });

  it("forwards workspace file content searches to the project RPC", async () => {
    rpcClientMock.projects.searchFileContents.mockResolvedValue({
      matches: [
        {
          path: "src/plan.md",
          line: 3,
          column: 5,
          lineText: "needle match",
        },
      ],
      truncated: false,
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.searchFileContents({
      cwd: "/tmp/project",
      query: "needle",
      limit: 10,
    });

    expect(rpcClientMock.projects.searchFileContents).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      query: "needle",
      limit: 10,
    });
  });

  it("forwards workspace directory change subscriptions to the project RPC", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onDirectoryChange = vi.fn();

    api.projects.onDirectoryChange(
      {
        cwd: "/tmp/project",
        relativePath: "docs",
      },
      onDirectoryChange,
    );

    const directoryEvent = {
      version: 1,
      type: "directoryChanged",
      relativePath: "docs",
    } satisfies ProjectDirectoryWatchEvent;
    emitEvent(projectDirectoryEventListeners, directoryEvent);

    expect(rpcClientMock.projects.onDirectoryChange).toHaveBeenCalledWith(
      {
        cwd: "/tmp/project",
        relativePath: "docs",
      },
      onDirectoryChange,
      undefined,
    );
    expect(onDirectoryChange).toHaveBeenCalledWith(directoryEvent);
  });
});
