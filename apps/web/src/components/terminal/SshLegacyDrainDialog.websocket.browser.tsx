import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  decide: vi.fn(),
}));

vi.mock("~/rpc/nativeApi", () => ({
  readNativeApi: () => ({
    server: { getBackendDrainConsent: mocks.get, decideBackendDrainConsent: mocks.decide },
  }),
  ensureNativeApi: () => ({ server: {} }),
}));

import { SshLegacyDrainConsentHost } from "./SshLegacyDrainConsentHost";

const snapshot = {
  drainId: "drain-1",
  deadlineAt: Date.now() + 60_000,
  panes: [
    {
      paneId: "thread-a:terminal-a",
      threadId: "thread-a",
      terminalId: "terminal-a",
      threadTitle: "Parser work",
      paneTitle: "direct ssh",
      surface: "direct-ssh" as const,
      keepMode: true,
    },
    {
      paneId: "thread-b:terminal-b",
      threadId: "thread-b",
      terminalId: "terminal-b",
      threadTitle: "Release work",
      paneTitle: "remote agent",
      surface: "remote-agent" as const,
      keepMode: false,
    },
  ],
};

describe("SSH drain consent over the WebSocket contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(snapshot);
    mocks.decide.mockResolvedValue({ status: "accepted", decision: "drain-now" });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the real pending panes and sends drain-now", async () => {
    const screen = await render(<SshLegacyDrainConsentHost />);
    await expect.element(screen.getByText("Parser work")).toBeVisible();
    await expect.element(screen.getByText("Release work")).toBeVisible();
    await screen.getByRole("button", { name: "Drain now" }).click();
    await vi.waitFor(() =>
      expect(mocks.decide).toHaveBeenCalledWith({ drainId: "drain-1", decision: "drain-now" }),
    );
  });

  it("Cancel blocks and writes no decision for the other actions", async () => {
    mocks.decide.mockResolvedValue({ status: "accepted", decision: "cancel" });
    const screen = await render(<SshLegacyDrainConsentHost />);
    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() =>
      expect(mocks.decide).toHaveBeenCalledWith({ drainId: "drain-1", decision: "cancel" }),
    );
    expect(mocks.decide).toHaveBeenCalledOnce();
  });

  it("save-and-close proceeds and a failed decision offers retry", async () => {
    mocks.decide.mockRejectedValueOnce(new Error("decision lost"));
    const screen = await render(<SshLegacyDrainConsentHost />);
    await screen.getByRole("button", { name: "Save and close" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("decision lost");
    mocks.decide.mockResolvedValue({ status: "accepted", decision: "drain-now" });
    await screen.getByRole("button", { name: "Retry" }).click();
    await expect.element(screen.getByText("Parser work")).toBeVisible();
  });
});
