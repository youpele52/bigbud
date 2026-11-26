import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ get: vi.fn(), drain: vi.fn() }));

vi.mock("~/rpc/nativeApi", () => ({
  readNativeApi: () => ({
    server: { getSshOwnerAdmission: mocks.get, drainSshOwnerIdentifiedPanes: mocks.drain },
  }),
  ensureNativeApi: () => ({ server: {} }),
}));

import { SshOwnerFenceNotice } from "./SshOwnerFenceNotice";

const fenced = {
  state: "fenced" as const,
  reason: "retirement-marker-missing" as const,
  message: "This backend cannot use SSH yet.",
  panes: [{ identity: "host-1:lease-a", threadId: "thread-a", paneId: "pane-a" }],
};

describe("SSH owner fence notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(fenced);
    mocks.drain.mockResolvedValue({ state: "open" });
  });
  afterEach(() => vi.clearAllMocks());

  it("shows the amber fence, lists the host panes and drains only on Drain", async () => {
    const screen = await render(<SshOwnerFenceNotice />);
    await expect.element(screen.getByText("SSH is paused")).toBeVisible();
    await screen.getByRole("button", { name: "Review drain" }).click();
    await expect.element(screen.getByText("thread-a")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Save and close" }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Drain identified panes" }).click();
    await vi.waitFor(() => expect(mocks.drain).toHaveBeenCalledOnce());
    await expect.element(screen.getByText("SSH is paused")).not.toBeInTheDocument();
  });

  it("Cancel closes the dialog without draining and keeps the notice", async () => {
    const screen = await render(<SshOwnerFenceNotice />);
    await screen.getByRole("button", { name: "Review drain" }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();
    await expect.element(screen.getByText("SSH is paused")).toBeVisible();
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it("renders nothing when SSH is not fenced", async () => {
    mocks.get.mockResolvedValue({ state: "inactive" });
    const screen = await render(<SshOwnerFenceNotice />);
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalled());
    await expect.element(screen.getByText("SSH is paused")).not.toBeInTheDocument();
  });
});
