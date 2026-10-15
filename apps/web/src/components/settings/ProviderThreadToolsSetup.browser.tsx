import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadId } from "@bigbud/contracts";
import { ProviderThreadToolsSetup } from "./ProviderThreadToolsSetup";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { getOpencodeV2ThreadToolsSetup: mocks.get } }),
}));
afterEach(() => mocks.get.mockReset());
const result = {
  status: "ready",
  directory: "/actual-worktree",
  nativePluginConfigRoot: "/native-config",
  severity: "success",
  message: "Required setup verified; compatible chats enroll automatically.",
};

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
    await expect.element(screen.getByRole("status")).toHaveClass("text-success");
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
    await expect.element(screen.getByRole("status")).toHaveClass("text-destructive");
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
    await expect.element(screen.getByRole("status")).toHaveClass("text-warning");
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
      .not.toBeVisible();
    reject!(new Error("Connection unavailable"));
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect.element(screen.getByRole("alert")).toHaveTextContent(/history is preserved/);
  } finally {
    await screen.unmount();
  }
});

it("runtime-checked readiness stays usable with a visible amber unqualified warning; incompatible states remain blocked", async () => {
  mocks.get.mockResolvedValue({
    ...result,
    status: "ready",
    activationState: "ready",
    nativeVersion: "2.0.28",
    qualificationState: "unqualified",
    severity: "warning",
    message:
      "Connected; runtime bridge checks passed. Native semantic qualification is incomplete.",
  });
  const screen = await render(<ProviderThreadToolsSetup enabled consented />);
  try {
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await screen.getByRole("button", { name: "Retry setup" }).click();
    await screen.getByText("Thread tools & setup", { exact: true }).click();
    await expect
      .element(screen.getByText("Native qualification: unqualified (2.0.28)"))
      .toBeVisible();
    await expect.element(screen.getByRole("status")).toHaveClass("text-warning");
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
    await expect.element(screen.getByRole("status")).toHaveClass("text-destructive");
    expect(mocks.get).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
  }
});
