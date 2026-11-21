import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  openWithSystemDefault: vi.fn(),
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../../lib/openSystemPath", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/openSystemPath")>()),
  openWithSystemDefault: mocks.openWithSystemDefault,
}));

import { useFilesPanelStore } from "./filesPanel.store";
import { openPathFromChat } from "./filesPanel.open";

describe("openPathFromChat by file type and machine", () => {
  beforeEach(() => {
    mocks.toast.mockReset();
    mocks.openWithSystemDefault.mockReset().mockResolvedValue({ kind: "opened" });
    useFilesPanelStore.setState({
      open: false,
      fileOpenRequest: null,
      workspaceRootOverride: null,
    });
  });

  it("opens a local file bigbud cannot show in the system app, by absolute path", async () => {
    await openPathFromChat("docs/report.docx", "/Users/me/project");
    expect(mocks.openWithSystemDefault).toHaveBeenCalledWith("/Users/me/project/docs/report.docx");
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("never hands a remote file bigbud cannot show to an app on this computer", async () => {
    await openPathFromChat("/srv/app/report.docx", "/srv/app", "file", "ssh:vps");
    expect(mocks.openWithSystemDefault).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "bigbud can't open this file type yet" }),
    );
    expect(useFilesPanelStore.getState().fileOpenRequest).toBeNull();
  });

  it("keeps opening types bigbud can show in bigbud, on the file's own machine", async () => {
    await openPathFromChat("/srv/app/notes.txt", "/srv/app", "file", "ssh:vps");
    expect(mocks.openWithSystemDefault).not.toHaveBeenCalled();
    expect(useFilesPanelStore.getState()).toMatchObject({
      workspaceRootOverride: "/srv/app",
      workspaceExecutionTargetIdOverride: "ssh:vps",
      fileOpenRequest: { path: "notes.txt" },
    });
  });
});
