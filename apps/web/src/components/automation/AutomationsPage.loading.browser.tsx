import "../../index.css";
import type { ReactNode } from "react";
import type { AutomationSchedule } from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { listAllAutomations, state, builderMounted, builderUnmounted } = vi.hoisted(() => ({
  listAllAutomations: vi.fn(),
  state: { connected: true, bootstrap: true },
  builderMounted: vi.fn(),
  builderUnmounted: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("~/components/chat/view/ThreadComposerSurface", () => ({
  ThreadComposerSurface: () => null,
}));
vi.mock("~/rpc/nativeApi", () => {
  const api = { server: { listAllAutomations } };
  return { readNativeApi: () => api };
});
vi.mock("~/rpc/serverState", () => ({
  useDefaultChatCwd: () => null,
  useServerProviders: () => [],
}));
vi.mock("~/rpc/wsConnectionState", () => ({
  useWsConnectionStatus: () => ({ phase: state.connected ? "connected" : "reconnecting" }),
}));
vi.mock("~/stores/main", () => ({
  useStore: (select: (store: unknown) => unknown) =>
    select({ projects: [], bootstrapComplete: state.bootstrap }),
}));
vi.mock("~/stores/ui", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) => select({ selectedProjectId: null }),
}));
vi.mock("~/stores/composer", () => ({ EMPTY_THREAD_DRAFT: {}, useComposerDraftStore: () => ({}) }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./useAutomationBuilderThread", async () => {
  const { useEffect } = await import("react");
  return {
    disposeAutomationBuilderThread: vi.fn(),
    useAutomationBuilderThread: () => {
      useEffect(() => {
        builderMounted();
        return () => {
          builderUnmounted();
        };
      }, []);
      return { builderThread: null, builderThreadId: null };
    },
  };
});
vi.mock("./AutomationListRow", () => ({
  AutomationListRow: ({
    automation,
    onAutomationsChange,
  }: {
    automation: AutomationSchedule;
    onAutomationsChange: () => void;
  }) => <button onClick={onAutomationsChange}>{automation.title}</button>,
}));
vi.mock("./AutomationPageHeader", () => ({
  AutomationListPageHeader: () => <header>Scheduled</header>,
}));
vi.mock("./AutomationPageShell", () => ({
  AutomationPageShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <div className="flex flex-col" style={{ height: 600 }}>
      {header}
      {children}
    </div>
  ),
}));

import { AutomationsPage } from "./AutomationsPage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let screen: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  listAllAutomations.mockReset();
  state.connected = true;
  state.bootstrap = true;
  builderMounted.mockClear();
  builderUnmounted.mockClear();
});
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
});

it("waits for bootstrap/connection, loads once, and ends loading on an empty list", async () => {
  state.bootstrap = false;
  const request = deferred<{ automations: [] }>();
  listAllAutomations.mockReturnValue(request.promise);
  screen = await render(<AutomationsPage />);
  expect(listAllAutomations).not.toHaveBeenCalled();
  await expect.element(screen.getByText("Scheduled", { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".animate-pulse-slow")).toHaveLength(1);
  state.bootstrap = true;
  await screen.rerender(<AutomationsPage />);
  await expect.poll(() => listAllAutomations.mock.calls.length).toBe(1);
  request.resolve({ automations: [] });
  await expect.element(screen.getByText("No automations yet.")).toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  expect(builderMounted).toHaveBeenCalledTimes(1);
  expect(builderUnmounted).not.toHaveBeenCalled();
});

it("retains existing rows during reload, reconnect, and reload failure", async () => {
  listAllAutomations.mockResolvedValueOnce({
    automations: [{ automationId: "task", title: "Daily task" }],
  });
  screen = await render(<AutomationsPage />);
  await expect.element(screen.getByRole("button", { name: "Daily task" })).toBeVisible();
  const refresh = deferred<unknown>();
  listAllAutomations.mockReturnValueOnce(refresh.promise);
  await screen.getByRole("button", { name: "Daily task" }).click();
  await expect.element(screen.getByRole("button", { name: "Daily task" })).toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  refresh.reject(new Error("offline"));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("offline");
  state.connected = false;
  await screen.rerender(<AutomationsPage />);
  await expect.element(screen.getByRole("button", { name: "Daily task" })).toBeVisible();
});

it("ends loading on initial failure and retries", async () => {
  listAllAutomations.mockRejectedValueOnce(new Error("offline"));
  screen = await render(<AutomationsPage />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent("offline");
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  listAllAutomations.mockResolvedValueOnce({ automations: [] });
  await screen.getByRole("button", { name: "Retry" }).click();
  await expect.element(screen.getByText("No automations yet.")).toBeVisible();
});

it("ignores a list response from a superseded connection", async () => {
  const old = deferred<unknown>();
  const current = deferred<unknown>();
  listAllAutomations.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  screen = await render(<AutomationsPage />);
  state.connected = false;
  await screen.rerender(<AutomationsPage />);
  state.connected = true;
  await screen.rerender(<AutomationsPage />);
  current.resolve({ automations: [{ automationId: "current", title: "Current task" }] });
  await expect.element(screen.getByRole("button", { name: "Current task" })).toBeVisible();
  old.resolve({ automations: [] });
  await expect.element(screen.getByRole("button", { name: "Current task" })).toBeVisible();
});
