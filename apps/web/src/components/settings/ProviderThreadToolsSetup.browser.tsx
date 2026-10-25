import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadId } from "@bigbud/contracts";
import { ProviderThreadToolsSetup } from "./ProviderThreadToolsSetup";
import { deferredSetupReply } from "../chat/provider/opencodeSetup.test.fixture";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { getOpencodeV2ThreadToolsSetup: mocks.get } }),
}));
afterEach(() => {
  mocks.get.mockReset();
  vi.useRealTimers();
});
const result = {
  status: "ready",
  directory: "/actual-worktree",
  nativePluginConfigRoot: "/native-config",
  severity: "success",
  message: "Required setup verified; compatible chats enroll automatically.",
};

const queued = {
  ...result,
  status: "required",
  activationState: "waiting-for-idle",
  severity: "info",
  jobId: "a".repeat(32),
  interestId: "b".repeat(32),
  message: "Waiting for active native work.",
};

// role="status" sits on the inner StatusBanner; the severity tone is on the labelled section.
const setupStatus = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("region", { name: "OpenCode setup status" });

it("Show status retains the queued handle and cancellation interest without another setup", async () => {
  const { interestId: _interest, ...status } = queued;
  mocks.get.mockResolvedValueOnce(queued).mockResolvedValue(status);
  const screen = await render(<ProviderThreadToolsSetup enabled consented />);
  try {
    await screen.getByRole("button", { name: "Retry setup" }).click();
    await expect.element(screen.getByText(queued.message)).toBeVisible();
    await screen.getByRole("button", { name: "Show status" }).click();
    expect(mocks.get).toHaveBeenLastCalledWith({ operation: "status", jobId: queued.jobId });
    await expect
      .element(screen.getByRole("button", { name: "Cancel this setup request" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Cancel this setup request" }).click();
    expect(mocks.get).toHaveBeenLastCalledWith({
      operation: "cancel-interest",
      jobId: queued.jobId,
      interestId: queued.interestId,
    });
    expect(mocks.get.mock.calls.filter(([input]) => input.refresh === true)).toHaveLength(1);
  } finally {
    await screen.unmount();
  }
});

it("keeps an expired job result visible during a failed Show status refresh", async () => {
  const expired = {
    ...queued,
    activationState: "deferred",
    message: "Setup expired waiting for idle.",
  };
  const status = deferredSetupReply<unknown>();
  mocks.get.mockResolvedValueOnce(expired).mockImplementationOnce(async () => {
    await status.promise;
    throw new Error("Status unavailable");
  });
  const screen = await render(<ProviderThreadToolsSetup enabled consented />);
  try {
    await screen.getByRole("button", { name: "Retry setup" }).click();
    await screen.getByRole("button", { name: "Show status" }).click();
    expect(mocks.get).toHaveBeenLastCalledWith({ operation: "status", jobId: queued.jobId });
    await expect.element(screen.getByText(expired.message)).toBeVisible();
    status.resolve(undefined);
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect.element(screen.getByText(expired.message)).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("times out a stalled status request, retains the last result, and fences late replies", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stalled = deferredSetupReply<unknown>();
  mocks.get.mockResolvedValueOnce(queued).mockReturnValueOnce(stalled.promise);
  const screen = await render(<ProviderThreadToolsSetup enabled consented />);
  try {
    await screen.getByRole("button", { name: "Retry setup" }).click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.get).toHaveBeenLastCalledWith({ operation: "status", jobId: queued.jobId });
    await vi.advanceTimersByTimeAsync(298000);
    await expect.element(screen.getByRole("alert")).toHaveTextContent("stopped or timed out");
    await expect.element(screen.getByText(queued.message)).toBeVisible();
    stalled.resolve({
      ...result,
      activationState: "ready",
      message: "Late success must not replace queued status.",
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect
      .element(screen.getByText("Late success must not replace queued status."))
      .not.toBeInTheDocument();
    const { interestId: _interest, ...status } = queued;
    mocks.get.mockResolvedValue(status);
    await screen.getByRole("button", { name: "Show status" }).click();
    expect(mocks.get).toHaveBeenLastCalledWith({ operation: "status", jobId: queued.jobId });
    await screen.getByRole("button", { name: "Cancel this setup request" }).click();
    expect(mocks.get).toHaveBeenLastCalledWith({
      operation: "cancel-interest",
      jobId: queued.jobId,
      interestId: queued.interestId,
    });
  } finally {
    await screen.unmount();
  }
});

it("infers Location without a chat-directory input, exposes config placement only, and opening settings writes nothing", async () => {
  mocks.get.mockResolvedValue(result);
  const change = vi.fn(async () => {});
  const threadId = ThreadId.makeUnsafe("context-thread");
  const screen = await render(
    <ProviderThreadToolsSetup consented enabled threadId={threadId} onConfigRootChange={change} />,
  );
  try {
    expect(mocks.get).not.toHaveBeenCalled();
    await expect
      .element(screen.getByRole("textbox", { name: "Selected native Location directory" }))
      .not.toBeInTheDocument();
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await screen.getByText("Setup details", { exact: true }).click();
    await screen.getByText("Plugin configuration", { exact: true }).click();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Retry setup" }).click();
    expect(mocks.get).toHaveBeenLastCalledWith({ threadId, refresh: true });
    await expect
      .element(screen.getByText("Detected chat Location: /actual-worktree"))
      .toBeVisible();
    await expect.element(setupStatus(screen)).toHaveClass("text-success");
    const field = screen.getByRole("textbox", {
      name: "Plugin config directory (optional)",
    });
    await field.fill("/override-config");
    await expect.element(screen.getByRole("button", { name: "Retry setup" })).toBeDisabled();
    await screen.getByRole("button", { name: "Save", exact: true }).click();
    expect(change).toHaveBeenLastCalledWith("/override-config");
    await screen.rerender(
      <ProviderThreadToolsSetup
        consented
        enabled
        threadId={threadId}
        configRoot="/override-config"
        onConfigRootChange={change}
      />,
    );
    await field.fill("");
    await screen.getByRole("button", { name: "Save", exact: true }).click();
    expect(change).toHaveBeenLastCalledWith("");
    expect(mocks.get).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
  }
});

it("explicit persisted expanded acknowledgement triggers setup once, but revocation fences late UI results", async () => {
  let resolve: (value: unknown) => void = () => {};
  mocks.get.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const screen = await render(<ProviderThreadToolsSetup enabled setupRequest={0} />);
  try {
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Retry setup" })).toBeDisabled();
    await screen.rerender(<ProviderThreadToolsSetup enabled consented setupRequest={1} />);
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    // Before any result, the only status is the in-flight "Verifying…" line.
    await expect.element(screen.getByRole("status")).toHaveClass("text-info");
    await screen.rerender(<ProviderThreadToolsSetup enabled setupRequest={1} />);
    resolve(result);
    await expect.element(screen.getByText(result.message)).not.toBeInTheDocument();
    await screen.unmount();
    const reopened = await render(<ProviderThreadToolsSetup enabled consented setupRequest={1} />);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await reopened.unmount();
  } finally {
    await screen.unmount();
  }
});

it("truthfully separates native failures and nonfatal settling/remediation status", async () => {
  mocks.get.mockResolvedValue({
    ...result,
    status: "unavailable",
    severity: "error",
    message: "V2 setup failed; no native prompt admitted.",
  });
  const screen = await render(<ProviderThreadToolsSetup enabled consented />);
  try {
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await screen.getByRole("button", { name: "Retry setup" }).click();
    await expect.element(setupStatus(screen)).toHaveClass("text-destructive");
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await expect.element(screen.getByRole("status")).toBeVisible();
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    mocks.get.mockResolvedValue({
      ...result,
      status: "required",
      severity: "warning",
      message: "V2 watching is settling; retry.",
    });
    await screen.getByRole("button", { name: "Retry setup" }).click();
    await expect.element(setupStatus(screen)).toHaveClass("text-warning");
  } finally {
    await screen.unmount();
  }
});

it("keeps automatic setup progress and errors visible without expanding advanced controls", async () => {
  let reject: (reason: Error) => void;
  const promise = new Promise((_resolve, onReject) => {
    reject = onReject;
  });
  mocks.get.mockReturnValue(promise);
  const screen = await render(<ProviderThreadToolsSetup enabled setupRequest={0} />);
  try {
    await screen.rerender(<ProviderThreadToolsSetup enabled consented setupRequest={1} />);
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    await expect.element(screen.getByRole("status")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Retry setup", includeHidden: true }))
      .toBeVisible();
    reject!(new Error("Connection unavailable"));
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect.element(screen.getByRole("alert")).toHaveTextContent(/history is preserved/);
  } finally {
    await screen.unmount();
  }
});

it("runtime-checked readiness is ready without a warning; incompatible states remain blocked", async () => {
  mocks.get.mockResolvedValue({
    ...result,
    status: "ready",
    activationState: "ready",
    nativeVersion: "2.0.28",
    qualificationState: "unqualified",
    severity: "success",
    message: "Required plugin ABI, issuer, artifact and detected Location verified.",
  });
  const screen = await render(<ProviderThreadToolsSetup enabled consented />);
  try {
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await screen.getByRole("button", { name: "Retry setup" }).click();
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await expect
      .element(screen.getByText("Native qualification: unqualified (2.0.28)"))
      .toBeVisible();
    await expect.element(setupStatus(screen)).toHaveClass("text-success");
    expect(mocks.get).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValue({
      ...result,
      status: "required",
      activationState: "blocked",
      nativeVersion: "2.0.28",
      qualificationState: "incompatible",
      severity: "error",
      message: "Native contract incompatible; no canonical execution or installation.",
    });
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await screen.getByRole("button", { name: "Retry setup" }).click();
    await expect
      .element(screen.getByText("Native qualification: incompatible (2.0.28)"))
      .toBeVisible();
    await expect.element(setupStatus(screen)).toHaveClass("text-destructive");
    expect(mocks.get).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
  }
});
