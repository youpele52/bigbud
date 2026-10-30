import "~/index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { OrchestrationDeliveryStreamItem } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import { ITUTU_COUNT_REFRESH_DELAY_MS } from "../../constants/sidebar";
import { SidebarItutuGroupLabel } from "./Sidebar.itutuGroupLabel";

type Listener = (item: OrchestrationDeliveryStreamItem) => void | Promise<void>;
const api = vi.hoisted(() => ({
  available: true,
  request: vi.fn(),
  listeners: new Set<Listener>(),
  resubscribe: new Set<() => void>(),
  unsubscribe: vi.fn(),
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () =>
    api.available
      ? {
          orchestration: {
            getOrganizationThreadSummaries: api.request,
            onDomainEvent: (callback: Listener, options: { onResubscribe: () => void }) => {
              api.listeners.add(callback);
              api.resubscribe.add(options.onResubscribe);
              return () => {
                api.listeners.delete(callback);
                api.resubscribe.delete(options.onResubscribe);
                api.unsubscribe();
              };
            },
          },
        }
      : undefined,
}));

function emit(...types: OrchestrationEvent["type"][]) {
  const item: OrchestrationDeliveryStreamItem = {
    type: "batch",
    route: "direct-unmanaged",
    consumerId: "counts",
    consumerGeneration: 1,
    serverEpoch: "epoch",
    subscriptionGeneration: 1,
    batchId: "batch",
    events: types.map((type) => ({ type }) as OrchestrationEvent),
  };
  for (const callback of api.listeners) void callback(item);
}
const settleRefresh = () =>
  new Promise((resolve) => setTimeout(resolve, ITUTU_COUNT_REFRESH_DELAY_MS + 30));

beforeEach(() => {
  api.available = true;
  api.request.mockReset().mockResolvedValue({ totalCount: 75, threads: [] });
  api.unsubscribe.mockClear();
  api.listeners.clear();
  api.resubscribe.clear();
});

it.each([
  ["present", "Present", 75],
  ["needs-you", "Needs you", 1],
  ["later", "Later", 0],
  ["done", "Done", 250],
] as const)(
  "keeps the full %s count ready without extra hover requests, even when collapsed",
  async (state, label, total) => {
    api.request.mockResolvedValue({ totalCount: total, threads: [] });
    const onExpandedChange = vi.fn();
    const screen = await render(
      <SidebarItutuGroupLabel
        state={state}
        isExpanded={false}
        onExpandedChange={onExpandedChange}
      />,
    );
    const button = screen.getByRole("button", { name: new RegExp(`^${label} `) });
    await expect.element(button).toHaveTextContent(`${label}(${total})`);
    expect(api.request).toHaveBeenCalledExactlyOnceWith({
      state,
      limit: 1,
      includeTotalCount: true,
    });
    await button.hover();
    await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();
    expect(api.request).toHaveBeenCalledTimes(1);
    await button.click();
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  },
);

it("reveals the count only on hover or click/focus without shifting the heading", async () => {
  const screen = await render(
    <>
      <SidebarItutuGroupLabel state="present" isExpanded onExpandedChange={vi.fn()} />
      <button>Elsewhere</button>
    </>,
  );
  const button = screen.getByRole("button", { name: /^Present / });
  const elsewhere = screen.getByRole("button", { name: "Elsewhere", exact: true });
  const count = screen.getByText("(75)");
  await expect.element(count).toBeInTheDocument();
  await elsewhere.hover();
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("0");
  const initialWidth = button.element().getBoundingClientRect().width;
  await button.hover();
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("1");
  expect(button.element().getBoundingClientRect().width).toBe(initialWidth);
  await elsewhere.hover();
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("0");
  await button.click();
  await elsewhere.hover();
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("1");
  await elsewhere.click();
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("0");
  expect(button.element().getBoundingClientRect().width).toBe(initialWidth);
  expect(api.request).toHaveBeenCalledTimes(1);
});

it("reveals counts for keyboard focus and preserves expansion without refetching", async () => {
  const onExpandedChange = vi.fn();
  const screen = await render(
    <SidebarItutuGroupLabel state="later" isExpanded onExpandedChange={onExpandedChange} />,
  );
  const count = screen.getByText("(75)");
  await expect.element(count).toBeInTheDocument();
  await userEvent.keyboard("{Tab}{Enter}");
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("1");
  expect(onExpandedChange).toHaveBeenCalledWith(false);
  await screen.rerender(
    <SidebarItutuGroupLabel state="later" isExpanded={false} onExpandedChange={onExpandedChange} />,
  );
  await expect.element(count).toBeInTheDocument();
  expect(api.request).toHaveBeenCalledTimes(1);
});

it("coalesces live membership changes and ignores streamed text", async () => {
  const screen = await render(
    <SidebarItutuGroupLabel state="later" isExpanded={false} onExpandedChange={vi.fn()} />,
  );
  await expect.element(screen.getByText("(75)")).toBeInTheDocument();
  emit("thread.message-sent", "thread.activity-appended");
  await settleRefresh();
  expect(api.request).toHaveBeenCalledTimes(1);
  api.request.mockResolvedValue({ totalCount: 76 });
  emit("thread.organization-updated");
  emit("thread.created", "thread.archived", "thread.deleted");
  await expect.element(screen.getByText("(76)")).toBeInTheDocument();
  expect(api.request).toHaveBeenCalledTimes(2);
});

it("refreshes after reconnect and removes the subscription on unmount", async () => {
  const screen = await render(
    <SidebarItutuGroupLabel state="done" isExpanded onExpandedChange={vi.fn()} />,
  );
  await expect.element(screen.getByText("(75)")).toBeInTheDocument();
  api.request.mockResolvedValue({ totalCount: 80 });
  for (const callback of api.resubscribe) callback();
  await expect.element(screen.getByText("(80)")).toBeInTheDocument();
  emit("thread.organization-updated");
  await screen.unmount();
  await settleRefresh();
  expect(api.request).toHaveBeenCalledTimes(2);
  expect(api.unsubscribe).toHaveBeenCalledOnce();
  expect(api.listeners.size).toBe(0);
});

it.each(["offline", "legacy response", "request failure"])(
  "keeps an unavailable marker rather than zero for %s",
  async (failure) => {
    api.available = failure !== "offline";
    if (failure === "legacy response") api.request.mockResolvedValue({ threads: [] });
    if (failure === "request failure") api.request.mockRejectedValue(new Error("Disconnected"));
    const screen = await render(
      <SidebarItutuGroupLabel state="done" isExpanded onExpandedChange={vi.fn()} />,
    );
    await expect.element(screen.getByText("(—)")).toBeInTheDocument();
    await expect.element(screen.getByLabelText("Thread count unavailable")).toBeInTheDocument();
  },
);

it("serializes updates arriving during a pending count and ignores its stale result", async () => {
  let resolveOld!: (page: { totalCount: number }) => void;
  api.request.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const screen = await render(
    <SidebarItutuGroupLabel state="present" isExpanded onExpandedChange={vi.fn()} />,
  );
  await expect.element(screen.getByText("(…)")).toBeInTheDocument();
  emit("thread.organization-updated");
  emit("thread.created");
  await settleRefresh();
  expect(api.request).toHaveBeenCalledTimes(1);
  resolveOld({ totalCount: 99 });
  await expect.element(screen.getByText("(75)")).toBeInTheDocument();
  expect(api.request).toHaveBeenCalledTimes(2);
  await expect.element(screen.getByText("(99)")).not.toBeInTheDocument();
});

it("ignores a pending response after the displayed group changes", async () => {
  let resolveOld!: (page: { totalCount: number }) => void;
  api.request.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const screen = await render(
    <SidebarItutuGroupLabel state="later" isExpanded onExpandedChange={vi.fn()} />,
  );
  await expect.element(screen.getByText("(…)")).toBeInTheDocument();
  await screen.rerender(
    <SidebarItutuGroupLabel state="done" isExpanded onExpandedChange={vi.fn()} />,
  );
  await expect.element(screen.getByText("(75)")).toBeInTheDocument();
  resolveOld({ totalCount: 99 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect.element(screen.getByText("(75)")).toBeInTheDocument();
  expect(api.unsubscribe).toHaveBeenCalledOnce();
});
