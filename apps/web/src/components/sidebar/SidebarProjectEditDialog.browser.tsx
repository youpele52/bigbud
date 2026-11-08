import "../../index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { Query, QueryFilters } from "@tanstack/react-query";
import { CommandId, ProjectId } from "@bigbud/contracts";
import { retainProjectEdit } from "./Sidebar.projectEdit.recovery";

const state = vi.hoisted(() => ({
  close: vi.fn(),
  save: vi.fn(),
  pickFolder: vi.fn(),
  outcome: vi.fn(),
  invalidate: vi.fn(),
  project: { id: "project-1", name: "Project", cwd: "/tmp/original", workspaceKind: "managed" },
}));
vi.mock("../../config/env", () => ({ isElectron: true }));
vi.mock("../../stores/main", () => ({
  useStore: (selector: (value: { projects: (typeof state.project)[] }) => unknown) =>
    selector({ projects: [state.project] }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ dialogs: { pickFolder: state.pickFolder } }),
  ensureNativeApi: () => ({ orchestration: { getCommandOutcome: state.outcome } }),
}));
vi.mock("./Sidebar.projectEdit.logic", () => ({
  useProjectEditor: () => ({ projectId: state.project.id, close: state.close }),
  saveLocalProject: state.save,
}));
import { SidebarProjectEditDialog } from "./SidebarProjectEditDialog";

async function mount() {
  const screen = await render(<SidebarProjectEditDialog />);
  return { [Symbol.asyncDispose]: () => screen.unmount() };
}

describe("SidebarProjectEditDialog folder selection", () => {
  afterEach(() => {
    vi.resetAllMocks();
    localStorage.removeItem("bigbud:project-edit-recovery:v1:project-1");
  });

  it("reopens a retained edit, shows native status and observes success without a new save", async () => {
    retainProjectEdit(ProjectId.makeUnsafe("project-1"), {
      command: {
        type: "project.reconfigure",
        commandId: CommandId.makeUnsafe("retained-edit"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/destination",
        expectedUpdatedAt: "2026-11-05T12:00:00.000Z",
        executionTargetId: "local",
        workspaceExecutionTargetId: "local",
        providerRuntimeExecutionTargetId: "local",
        verifiedWorktreePaths: [],
      },
      error: "Response lost",
    });
    state.outcome
      .mockResolvedValueOnce({
        status: "unknown",
        workspaceTransition: {
          operationId: "operation",
          phase: "recovery-required",
          sourcePath: "/tmp/original",
          destinationPath: "/tmp/destination",
          error: "Inspect native owner",
          steps: [
            {
              threadId: "thread",
              provider: "opencodeV2",
              nativeSessionId: "native",
              phase: "dispatched",
            },
          ],
        },
      })
      .mockResolvedValueOnce({ status: "accepted", resultSequence: 12 });
    await using _ = await mount();
    await expect.element(page.getByRole("heading", { name: "Recover project edit" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Check status" }));
    await expect.element(page.getByText("thread · opencodeV2 · native: dispatched")).toBeVisible();
    expect(state.save).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Check status" }));
    expect(state.close).toHaveBeenCalledOnce();
    expect(localStorage.getItem("bigbud:project-edit-recovery:v1:project-1")).toBeNull();
  });

  it("browses without an editable path and resets the selection", async () => {
    state.pickFolder.mockResolvedValue("/tmp/selected");
    await using _ = await mount();
    expect(document.querySelectorAll('input[type="text"], input:not([type])')).toHaveLength(1);
    await page.getByRole("button", { name: "Browse" }).click();
    await expect.element(page.getByLabelText("Selected folder")).toHaveTextContent("/tmp/selected");
    await page.getByRole("button", { name: "Reset folder" }).click();
    await expect.element(page.getByLabelText("Selected folder")).toHaveTextContent("/tmp/original");
  });

  it("keeps the original folder when browsing is cancelled", async () => {
    state.pickFolder.mockResolvedValue(null);
    await using _ = await mount();
    await page.getByRole("button", { name: "Browse" }).click();
    await expect.element(page.getByLabelText("Selected folder")).toHaveTextContent("/tmp/original");
  });

  it("shows picker errors without discarding the project", async () => {
    state.pickFolder.mockRejectedValue(new Error("Picker failed"));
    await using _ = await mount();
    await page.getByRole("button", { name: "Browse" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Picker failed");
    expect(state.close).not.toHaveBeenCalled();
  });

  it("blocks dismissal and duplicate submission until saving finishes", async () => {
    let finish!: () => void;
    state.save.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await using _ = await mount();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("{Escape}{Enter}");
    expect(state.close).not.toHaveBeenCalled();
    expect(state.save).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
  });

  it("invalidates only local queries for the previous and selected folders", async () => {
    state.pickFolder.mockResolvedValue("/tmp/selected");
    await using _ = await mount();
    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByRole("radio", { name: /Switch without moving files/ }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => expect(state.invalidate).toHaveBeenCalledOnce());
    const { predicate } = state.invalidate.mock.calls[0]![0] as QueryFilters;
    expect(predicate).toBeDefined();
    const matches = (queryKey: readonly unknown[]) => predicate!({ queryKey } as Query);
    expect(matches(["git", "status", "local", "/tmp/original"])).toBe(true);
    expect(matches(["projects", "search-entries", "local", "/tmp/selected", "", 80])).toBe(true);
    expect(matches(["git", "status", "ssh:remote", "/tmp/selected"])).toBe(false);
    expect(matches(["projects", "search-entries", "local", "/tmp/unrelated", "", 80])).toBe(false);
    expect(matches(["other", "status", "local", "/tmp/selected"])).toBe(false);
  });

  it("requires explicit Muse reset confirmation and keeps exact retry identity", async () => {
    state.pickFolder.mockResolvedValue("/tmp/selected");
    state.save
      .mockRejectedValueOnce(
        new Error("Explicit Muse native-context reset confirmation is required"),
      )
      .mockRejectedValue(new Error("Workspace operation retained for recovery"));
    await using _ = await mount();
    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(state.save.mock.calls[0]?.[0].nativeContextReset).toBe(false);
    const checkbox = page.getByRole("checkbox", {
      name: "Allow Muse conversations to start fresh",
    });
    await expect.element(checkbox).not.toBeChecked();
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect
      .element(page.getByText(/their context does not carry into the fresh session/))
      .toBeVisible();
    await checkbox.click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("retained for recovery");
    expect(state.save.mock.calls[1]?.[0].nativeContextReset).toBe(true);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => expect(state.save).toHaveBeenCalledTimes(3));
    expect(state.save.mock.calls[2]?.[0].commandId).toBe(state.save.mock.calls[1]?.[0].commandId);
    expect(state.save.mock.calls[1]?.[0].commandId).not.toBe(
      state.save.mock.calls[0]?.[0].commandId,
    );
    expect(state.close).not.toHaveBeenCalled();
  });

  it("clears reset consent when the folder is reset", async () => {
    state.pickFolder.mockResolvedValue("/tmp/selected");
    state.save.mockRejectedValue(
      new Error("Explicit Muse native-context reset confirmation is required"),
    );
    await using _ = await mount();
    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("checkbox", { name: "Allow Muse conversations to start fresh" }).click();
    await page.getByRole("button", { name: "Reset folder" }).click();
    await page.getByRole("button", { name: "Browse" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Allow Muse conversations to start fresh" }))
      .not.toBeChecked();
    expect(state.save.mock.calls[1]?.[0].nativeContextReset).toBe(false);
  });

  it("preserves rename with the existing folder", async () => {
    await using _ = await mount();
    await page.getByLabelText("Project name").fill("Renamed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Renamed", directory: "/tmp/original" }),
    );
  });
});
