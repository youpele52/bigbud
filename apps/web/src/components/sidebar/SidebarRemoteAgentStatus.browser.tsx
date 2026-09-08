import "../../index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SidebarRemoteAgentStatus } from "./SidebarRemoteAgentStatus";

const api = vi.hoisted(() => ({ current: null as never }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => api.current }));
afterEach(() => {
  api.current = null as never;
  document.body.innerHTML = "";
});

describe("explicit remote admission outcome", () => {
  it("shows same-version fallback after admission and reload without connecting again", async () => {
    const fallback = {
      connectionId: "fallback",
      currentVersion: "0.2.207",
      pendingVersion: null,
      fallbackVersion: null,
      currentBuildId: "healthy-build",
      requestedBuildId: "failed-build",
      outcome: "fallback",
      failureCode: "NOT_READY",
    };
    const verifyExecutionTarget = vi
      .fn()
      .mockResolvedValueOnce({
        remoteAgent: {
          status: "ready",
          version: "0.2.207",
          runtimeSummary: {
            currentVersion: "0.2.207",
            pendingVersion: "0.2.207",
            fallbackVersion: null,
          },
        },
      })
      .mockResolvedValue({
        remoteAgent: { status: "ready", version: "0.2.207", runtimeSummary: fallback },
      });
    const connectRemoteAgent = vi.fn().mockResolvedValue(fallback);
    const getRemoteAgentUpdateStatus = vi.fn().mockResolvedValue({
      executionTargetId: "ssh:test",
      phase: "connected",
      updateRequestId: null,
      reconnectRequestId: null,
      reconnectOutcome: null,
      currentVersion: "0.2.207",
      pendingVersion: "0.2.207",
      predecessorVersion: null,
      reason: null,
    });
    api.current = {
      server: { verifyExecutionTarget, connectRemoteAgent, getRemoteAgentUpdateStatus },
    } as never;
    const screen = await render(
      <SidebarRemoteAgentStatus executionTargetId="ssh:test" cwd="/workspace" />,
    );
    await vi.waitFor(() => expect(verifyExecutionTarget).toHaveBeenCalledOnce());
    await page.getByRole("button", { name: "Connect new session" }).click();
    await expect
      .element(page.getByText("Using healthy fallback 0.2.207. Candidate admission: NOT_READY."))
      .toBeVisible();
    await screen.unmount();
    await render(<SidebarRemoteAgentStatus executionTargetId="ssh:test" cwd="/workspace" />);
    await expect
      .element(page.getByText("Using healthy fallback 0.2.207. Candidate admission: NOT_READY."))
      .toBeVisible();
    expect(connectRemoteAgent).toHaveBeenCalledOnce();
  });

  it("recovers the same request identity after a lost reply and remount", async () => {
    const target = `ssh:recovery-${crypto.randomUUID()}`;
    const verifyExecutionTarget = vi.fn().mockResolvedValue({});
    const getRemoteAgentUpdateStatus = vi.fn().mockResolvedValue({
      executionTargetId: target,
      phase: "ready-for-next-reconnect",
      updateRequestId: "update-1",
      reconnectRequestId: null,
      reconnectOutcome: "pending",
      currentVersion: "0.2.207",
      pendingVersion: "0.2.208",
      predecessorVersion: "0.2.205",
      reason: null,
    });
    const connectRemoteAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("reply lost"))
      .mockResolvedValue({
        connectionId: "connection",
        currentVersion: "0.2.208",
        pendingVersion: null,
        fallbackVersion: "0.2.207",
      });
    api.current = {
      server: { verifyExecutionTarget, connectRemoteAgent, getRemoteAgentUpdateStatus },
    } as never;

    const firstScreen = await render(
      <SidebarRemoteAgentStatus executionTargetId={target} cwd="/workspace" />,
    );
    await page.getByRole("button", { name: "Connect new session" }).click();
    await expect.element(page.getByText("reply lost")).toBeVisible();
    const requestId = connectRemoteAgent.mock.calls[0]?.[0].requestId;
    expect(requestId).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    await firstScreen.unmount();

    await render(<SidebarRemoteAgentStatus executionTargetId={target} cwd="/workspace" />);
    await vi.waitFor(() =>
      expect(getRemoteAgentUpdateStatus).toHaveBeenLastCalledWith({
        executionTargetId: target,
        reconnectRequestId: requestId,
      }),
    );
    await page.getByRole("button", { name: "Connect new session" }).click();
    await expect.element(page.getByText(/Connected to .*0\.2\.208/)).toBeVisible();
    expect(connectRemoteAgent).toHaveBeenCalledTimes(2);
    expect(connectRemoteAgent.mock.calls[1]?.[0].requestId).toBe(requestId);
    expect(getRemoteAgentUpdateStatus).toHaveBeenLastCalledWith({
      executionTargetId: target,
      reconnectRequestId: requestId,
    });
  });

  it("renders every persisted phase with exact versions, reasons, and severity", async () => {
    const phases = [
      {
        phase: "installing",
        message: "Installing verified update 0.2.208. Existing work is unchanged.",
        className: "text-blue-600",
      },
      {
        phase: "checking-health",
        message: "Checking update 0.2.208 before it can be selected.",
        className: "text-blue-600",
      },
      {
        phase: "ready-for-next-reconnect",
        message: "Update 0.2.208 is ready for the next deliberate connection.",
        className: "text-emerald-600",
      },
      {
        phase: "waiting-for-capacity",
        message: "Update 0.2.208 is waiting for a safe storage slot.",
        className: "text-amber-600",
      },
      {
        phase: "failed-using-stable",
        message: "Update unavailable; continuing with stable 0.2.207.",
        className: "text-amber-600",
      },
      {
        phase: "verification-unavailable",
        message: "Update verification is temporarily unavailable; existing work is unchanged.",
        className: "text-amber-600",
      },
      {
        phase: "connected",
        message: "Connected to the current stable remote agent.",
        className: "text-emerald-600",
      },
    ] as const;

    for (const [index, current] of phases.entries()) {
      const target = `ssh:phase-${index}-${crypto.randomUUID()}`;
      const connectRemoteAgent = vi.fn();
      api.current = {
        server: {
          verifyExecutionTarget: vi.fn().mockResolvedValue({}),
          connectRemoteAgent,
          getRemoteAgentUpdateStatus: vi.fn().mockResolvedValue({
            executionTargetId: target,
            phase: current.phase,
            updateRequestId: "update-1",
            reconnectRequestId: null,
            reconnectOutcome: null,
            currentVersion: "0.2.207",
            pendingVersion: "0.2.208",
            predecessorVersion: "0.2.205",
            reason: current.phase === "failed-using-stable" ? "HEALTH_CHECK_FAILED" : null,
          }),
        },
      } as never;

      const screen = await render(
        <SidebarRemoteAgentStatus executionTargetId={target} cwd="/workspace" />,
      );
      const status = page.getByText(current.message, { exact: true });
      await expect.element(status).toBeVisible();
      await expect.element(status).toHaveClass(current.className);
      await expect.element(page.getByText("0.2.207", { exact: true })).toBeVisible();
      await expect.element(page.getByText("0.2.208", { exact: true })).toBeVisible();
      await expect.element(page.getByText("0.2.205", { exact: true })).toBeVisible();
      expect(connectRemoteAgent).not.toHaveBeenCalled();
      await screen.unmount();
    }
  });
});
