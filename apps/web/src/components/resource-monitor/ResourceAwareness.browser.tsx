import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";
import type { ResourceAwarenessState } from "@bigbud/contracts/system-monitor/awareness.ts";
import { defaultResourcePreferences } from "@bigbud/shared/resourceAwareness.preferences";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  add: vi.fn(
    (_toast: { type?: string; description?: ReactNode; actionProps?: { onClick?: () => void } }) =>
      "resource-toast",
  ),
  close: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../ui/toast.manager", () => ({ toastManager: { add: mocks.add, close: mocks.close } }));
import { ResourceAwarenessToastCoordinator } from "./ResourceAwarenessToastCoordinator";
import { ResourceAwarenessSettings } from "./ResourceAwarenessSettings";

let screen: Awaited<ReturnType<typeof render>> | undefined;
const original = window.desktopBridge;
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: original });
  vi.clearAllMocks();
});
function state(): ResourceAwarenessState {
  return {
    preferences: defaultResourcePreferences(),
    health: "healthy",
    sampledAtMs: Date.now(),
    alerts: [
      {
        id: "incident1",
        ruleId: "host-cpu",
        entity: "host",
        metric: "hostCpu",
        scope: "host",
        state: "active",
        value: 99,
        threshold: 95,
        startedAtMs: Date.now() - 60000,
        sampledAtMs: Date.now(),
        notifiedAtMs: Date.now(),
      },
    ],
  };
}
const ignoreState = () => undefined;
function bridge(initial = state()) {
  let next = initial;
  let receive: (value: ResourceAwarenessState) => void = ignoreState;
  const get = vi.fn(async () => next);
  const mutate = vi.fn(async (input: { enabled?: boolean }) => {
    next = {
      ...next,
      preferences: {
        ...next.preferences,
        revision: next.preferences.revision + 1,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
    };
    return next;
  });
  const ack = vi.fn(async () => undefined);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      resourceAwarenessGet: get,
      resourceAwarenessMutate: mutate,
      resourceAwarenessAcknowledge: ack,
      onResourceAwarenessState: (listener: typeof receive) => {
        receive = listener;
        return () => {
          receive = () => undefined;
        };
      },
    },
  });
  return { get, mutate, ack, emit: (value: ResourceAwarenessState) => receive(value) };
}

it("shows and acknowledges alerts without the monitor page, deduplicates live samples and closes snoozed alerts", async () => {
  const initial = state();
  const api = bridge(initial);
  screen = await render(<ResourceAwarenessToastCoordinator />);
  await expect.poll(() => mocks.add.mock.calls.length).toBe(1);
  expect(mocks.add.mock.calls[0]?.[0].type).toBe("warning");
  expect(api.ack).toHaveBeenCalledWith(["incident1"]);
  api.emit(initial);
  expect(mocks.add).toHaveBeenCalledOnce();
  mocks.add.mock.calls[0]?.[0].actionProps?.onClick?.();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/system-monitor" });
  api.emit({
    ...initial,
    preferences: { ...initial.preferences, snoozedUntilMs: Date.now() + 60000 },
  });
  await expect.poll(() => mocks.close.mock.calls.length).toBe(1);
});

it("does not replay a stale hydration result after newer live state", async () => {
  const initial = state();
  const api = bridge(initial);
  let resolve!: (value: ResourceAwarenessState) => void;
  api.get.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  screen = await render(<ResourceAwarenessToastCoordinator />);
  api.emit({
    ...initial,
    health: "disabled",
    preferences: { ...initial.preferences, enabled: false },
  });
  resolve(initial);
  await expect.poll(() => api.get.mock.calls.length).toBe(1);
  expect(mocks.add).not.toHaveBeenCalled();
});

it("edits persisted monitoring using the current revision and renders unsupported-data guidance", async () => {
  const api = bridge({ ...state(), alerts: [] });
  screen = await render(<ResourceAwarenessSettings />);
  await screen.getByText("Background resource alerts", { exact: false }).click();
  await screen.getByRole("checkbox", { name: "Enable background monitoring" }).click();
  await expect.poll(() => api.mutate.mock.calls.length).toBe(1);
  expect(api.mutate).toHaveBeenCalledWith({
    expectedRevision: 0,
    operation: "enable",
    enabled: false,
  });
  await expect
    .element(screen.getByText("No monitoring after quit", { exact: false }))
    .toBeVisible();
});
