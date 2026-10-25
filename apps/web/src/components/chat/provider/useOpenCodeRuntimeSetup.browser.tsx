import { expect, it, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { opencodeUpdateAdvice } from "@bigbud/shared/opencodeAdvisory";
import { useOpenCodeRuntimeSetup } from "./useOpenCodeRuntimeSetup";
import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { deferredSetupReply } from "./opencodeSetup.test.fixture";
import { OpenCodeSetupStatus } from "./OpenCodeSetupStatus";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  connection: {
    phase: "connected",
    connectedAt: "first-connection",
    socketUrl: "ws://localhost/ws",
  },
}));
vi.mock("~/rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { getOpencodeV2ThreadToolsSetup: mocks.get } }),
}));
vi.mock("~/rpc/wsConnectionState", () => ({ useWsConnectionStatus: () => mocks.connection }));

const provider: ServerProvider = {
  provider: "opencodeV2",
  enabled: true,
  installed: true,
  version: "2.0.28",
  status: "warning",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-14T12:00:00Z",
  initialProbeComplete: true,
  models: [],
  slashCommands: [],
  skills: [],
  message: `Connected to your native OpenCode service. ${opencodeUpdateAdvice("2.0.28", "2.1.4")}`,
  runtimeUpdateRecommended: "2.1.4",
};
const updateAdvice = opencodeUpdateAdvice("2.0.28", "2.1.4");
const ready = {
  status: "ready",
  activationState: "ready",
  directory: "/workspace",
  artifactDigest: "a".repeat(64),
  nativeVersion: "2.0.28",
  qualificationState: "unqualified",
};

function SetupHarness({
  consented = true,
  thread = "first-chat",
  status = provider,
  showSetup = false,
}: {
  consented?: boolean;
  thread?: string;
  status?: ServerProvider;
  showSetup?: boolean;
}) {
  const setup = useOpenCodeRuntimeSetup({
    status,
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS.providers.opencodeV2,
      enabled: true,
      connectionMode: "shared",
      nativeServiceTrust: consented ? "managed-thread-tools-v2" : null,
    },
    directory: "/workspace",
    threadId: ThreadId.makeUnsafe(thread),
    threadError: null,
  });
  return (
    <>
      <p role="status">{setup.verified ? "Runtime verified" : "Not verified"}</p>
      <ProviderStatusBanner status={status} />
      {setup.error ? <p role="alert">{setup.error}</p> : null}
      {showSetup ? (
        <OpenCodeSetupStatus
          result={setup.result}
          error={setup.error}
          onRetry={setup.retry}
          onCancel={() => void setup.cancel()}
        />
      ) : null}
    </>
  );
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.connection = {
    phase: "connected",
    connectedAt: "first-connection",
    socketUrl: "ws://localhost/ws",
  };
});
afterEach(() => vi.restoreAllMocks());

it.each(["cancel", "status"])(
  "coalesces double Cancel and fences delayed %s replies after switching chats",
  async (delayedOperation) => {
    const waiting = {
      ...ready,
      status: "required",
      activationState: "waiting-for-idle",
      jobId: "a".repeat(32),
      interestId: "b".repeat(32),
      message: "Waiting for another native client.",
    };
    const cancellation = deferredSetupReply<typeof waiting>();
    const observation = deferredSetupReply<typeof waiting>();
    mocks.get.mockImplementation(async (request) => {
      if (request.operation === "cancel-interest") return cancellation.promise;
      if (request.operation === "status") return observation.promise;
      return request.threadId === "first-chat" ? waiting : ready;
    });
    const screen = await render(<SetupHarness showSetup />);
    await expect
      .element(screen.getByText("OpenCode setup queued — waiting for idle"))
      .toBeVisible();
    const cancel = screen.getByRole("button", { name: "Cancel this setup request" });
    await cancel.click();
    await cancel.click();
    expect(
      mocks.get.mock.calls.filter(([request]) => request.operation === "cancel-interest"),
    ).toHaveLength(1);
    if (delayedOperation === "status") {
      cancellation.resolve(waiting);
      await vi.waitFor(() =>
        expect(mocks.get).toHaveBeenCalledWith({ operation: "status", jobId: waiting.jobId }),
      );
    }
    await screen.rerender(<SetupHarness thread="second-chat" showSetup />);
    await expect.element(screen.getByText("Runtime verified", { exact: true })).toBeVisible();
    cancellation.resolve(waiting);
    observation.resolve({ ...waiting, activationState: "failed", message: "Stale failure" });
    // Drain the deferred RPC continuations before asserting that old-scope results stayed fenced.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect.element(screen.getByText("Runtime verified", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Stale failure")).not.toBeInTheDocument();
    expect(mocks.get.mock.calls.map(([request]) => request.operation ?? "setup")).toEqual(
      delayedOperation === "status"
        ? ["setup", "cancel-interest", "status", "setup"]
        : ["setup", "cancel-interest", "setup"],
    );
    await screen.unmount();
  },
);

it("keeps observing shared queued work after cancelling only this chat's interest", async () => {
  const jobId = "a".repeat(32),
    interestId = "b".repeat(32);
  const waiting = {
    ...ready,
    status: "required",
    activationState: "waiting-for-idle",
    jobId,
    message: "Waiting for another native client.",
  };
  mocks.get.mockImplementation(async (request) => {
    if (request.operation === "cancel-interest") return waiting;
    if (request.operation === "status")
      return {
        ...waiting,
        activationState: "deferred",
        message: "Setup expired while waiting for idle.",
      };
    return { ...waiting, interestId };
  });
  const screen = await render(<SetupHarness showSetup />);
  await expect.element(screen.getByText("OpenCode setup queued — waiting for idle")).toBeVisible();
  await screen.getByRole("button", { name: "Cancel this setup request" }).click();
  await expect.element(screen.getByText("OpenCode setup — deferred")).toBeVisible();
  expect(mocks.get.mock.calls.map(([request]) => request.operation ?? "setup")).toEqual([
    "setup",
    "cancel-interest",
    "status",
  ]);
  expect(mocks.get).toHaveBeenCalledWith({ operation: "cancel-interest", jobId, interestId });
  await screen.unmount();
});

it("waits for consent, verifies without hiding the update advice, and does not repeat on a catalog refresh", async () => {
  const pending = deferredSetupReply<typeof ready>();
  mocks.get.mockReturnValue(pending.promise);
  const screen = await render(<SetupHarness consented={false} />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent(updateAdvice);
  expect(mocks.get).not.toHaveBeenCalled();
  await screen.rerender(<SetupHarness />);
  await vi.waitFor(() =>
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith({
      directory: "/workspace",
      threadId: "first-chat",
      refresh: true,
    }),
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Not verified");
  pending.resolve(ready);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Runtime verified");
  // The advice is about the service version, so runtime verification never hides it.
  await expect.element(screen.getByRole("alert")).toHaveTextContent(updateAdvice);
  await screen.rerender(
    <SetupHarness status={{ ...provider, checkedAt: "2026-10-14T12:01:00Z" }} />,
  );
  expect(mocks.get).toHaveBeenCalledOnce();
  await screen.unmount();
});

it("fences late results after switching chats or revoking trust", async () => {
  const first = deferredSetupReply<typeof ready>();
  const second = deferredSetupReply<typeof ready>();
  mocks.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const screen = await render(<SetupHarness />);
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
  await screen.rerender(<SetupHarness thread="second-chat" />);
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  first.resolve(ready);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Not verified");
  await screen.rerender(<SetupHarness thread="second-chat" consented={false} />);
  second.resolve(ready);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Not verified");
  await expect.element(screen.getByRole("alert")).toHaveTextContent(updateAdvice);
  await screen.unmount();
});

it("rechecks after reconnect and preserves an actual setup error", async () => {
  mocks.get.mockResolvedValueOnce(ready).mockResolvedValueOnce({
    status: "unavailable",
    activationState: "blocked",
    message: "Required bridge was denied.",
    severity: "error",
  });
  const screen = await render(<SetupHarness />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Runtime verified");
  mocks.connection = { ...mocks.connection, phase: "disconnected" };
  await screen.rerender(<SetupHarness />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Not verified");
  mocks.connection = { ...mocks.connection, phase: "connected", connectedAt: "second-connection" };
  await screen.rerender(<SetupHarness />);
  await expect.element(screen.getByText("Required bridge was denied.")).toBeInTheDocument();
  expect(mocks.get).toHaveBeenCalledTimes(2);
  await screen.unmount();
});

it.each([
  { directory: "/other-worktree" },
  { nativeVersion: "2.0.27" },
  { qualificationState: "incompatible" },
  { artifactDigest: "" },
])("never verifies mismatched/incomplete evidence: %j", async (override) => {
  mocks.get.mockResolvedValue({ ...ready, ...override });
  const screen = await render(<SetupHarness />);
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
  await expect.element(screen.getByRole("status")).toHaveTextContent("Not verified");
  await screen.unmount();
});

it.each<Partial<ServerProvider>>([
  { provider: "codex" },
  { enabled: false },
  { installed: false },
  { status: "error" },
  { initialProbeComplete: false },
  { auth: { status: "unauthenticated" } },
])("does not initiate native setup for an ineligible provider: %j", async (override) => {
  const screen = await render(<SetupHarness status={{ ...provider, ...override }} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Not verified");
  expect(mocks.get).not.toHaveBeenCalled();
  await screen.unmount();
});

it("invalidates an earlier successful check when the native version changes", async () => {
  mocks.get.mockResolvedValueOnce(ready);
  const later = deferredSetupReply<typeof ready>();
  mocks.get.mockReturnValueOnce(later.promise);
  const screen = await render(<SetupHarness />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Runtime verified");
  await screen.rerender(<SetupHarness status={{ ...provider, version: "2.0.29" }} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Not verified");
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  later.resolve({ ...ready, nativeVersion: "2.0.29" });
  await expect.element(screen.getByRole("status")).toHaveTextContent("Runtime verified");
  await screen.unmount();
});
