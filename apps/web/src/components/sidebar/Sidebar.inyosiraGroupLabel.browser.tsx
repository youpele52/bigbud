import "~/index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { OrchestrationDeliveryStreamItem } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import { INYOSIRA_COUNT_REFRESH_DELAY_MS } from "../../constants/sidebar";
import type { ComponentProps } from "react";
import { useInyosiraThreadCount } from "./Sidebar.inyosira.count";
import { SidebarInyosiraGroupLabel as GroupLabel } from "./Sidebar.inyosiraGroupLabel";

/** Exercise the heading with its live count source, as used by each Inyosira group. */
function SidebarInyosiraGroupLabel(props: Omit<ComponentProps<typeof GroupLabel>, "result">) {
  const result = useInyosiraThreadCount(props.state);
  return <GroupLabel {...props} result={result} />;
}

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
  new Promise((resolve) => setTimeout(resolve, INYOSIRA_COUNT_REFRESH_DELAY_MS + 30));

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
      <SidebarInyosiraGroupLabel
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

it.each(["present", "later", "done"] as const)(
  "keeps the expanded %s count visible without hover or focus, including zero",
  async (state) => {
    api.request.mockResolvedValue({ totalCount: 0, threads: [] });
    const screen = await render(
      <>
        <SidebarInyosiraGroupLabel state={state} isExpanded onExpandedChange={vi.fn()} />
        <button>Elsewhere</button>
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "Elsewhere", exact: true });
    await elsewhere.click();
    const emptyCount = screen.getByLabelText("0 threads");
    await expect.element(emptyCount).toHaveTextContent("(0)");
    await expect.poll(() => getComputedStyle(emptyCount.element()).opacity).toBe("1");
    api.request.mockResolvedValue({ totalCount: 75, threads: [] });
    emit("thread.organization-updated");
    const count = screen.getByLabelText("75 threads");
    await expect.element(count).toHaveTextContent("(75)");
    await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("1");
  },
);

it.each([true, false])(
  "mutes empty Needs you without disabling expansion (%s)",
  async (isExpanded) => {
    api.request.mockResolvedValue({ totalCount: 0, threads: [] });
    const onExpandedChange = vi.fn();
    const screen = await render(
      <SidebarInyosiraGroupLabel
        state="needs-you"
        isExpanded={isExpanded}
        onExpandedChange={onExpandedChange}
      />,
    );
    const heading = screen.getByText("Needs you", { exact: true });
    const button = screen.getByRole("button", { name: "Needs you", exact: true });
    await expect
      .poll(() => heading.element().parentElement?.classList.contains("text-muted-foreground"))
      .toBe(true);
    await expect.element(screen.getByLabelText("0 threads")).not.toBeInTheDocument();
    await button.click();
    expect(onExpandedChange).toHaveBeenCalledWith(!isExpanded);
    api.request.mockResolvedValue({ totalCount: 1, threads: [] });
    emit("thread.organization-updated");
    await expect.element(screen.getByLabelText("1 thread")).toHaveTextContent("(1)");
    await expect
      .poll(() => heading.element().parentElement?.classList.contains("text-muted-foreground"))
      .toBe(false);
    api.request.mockResolvedValue({ totalCount: 0, threads: [] });
    emit("thread.organization-updated");
    await expect
      .poll(() => heading.element().parentElement?.classList.contains("text-muted-foreground"))
      .toBe(true);
  },
);

it.each([{ status: "loading" }, { status: "error" }, { status: "loaded", count: 0 }] as const)(
  "does not mute unknown counts or visible threads: %j",
  async (result) => {
    const screen = await render(
      <GroupLabel
        state="needs-you"
        result={result}
        hasThreads={result.status === "loaded"}
        isExpanded
        onExpandedChange={vi.fn()}
      />,
    );
    const heading = screen.getByText("Needs you", { exact: true });
    expect(heading.element().parentElement?.classList.contains("text-muted-foreground")).toBe(
      false,
    );
  },
);

it("updates count visibility when expanded or collapsed without refetching", async () => {
  const onExpandedChange = vi.fn();
  const content = (isExpanded: boolean) => (
    <>
      <SidebarInyosiraGroupLabel
        state="present"
        isExpanded={isExpanded}
        onExpandedChange={onExpandedChange}
      />
      <button>Elsewhere</button>
    </>
  );
  const screen = await render(content(false));
  const count = screen.getByText("(75)");
  await expect.element(count).toBeInTheDocument();
  await screen.getByRole("button", { name: "Elsewhere", exact: true }).click();
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("0");
  await screen.rerender(content(true));
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("1");
  await screen.rerender(content(false));
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("0");
  expect(api.request).toHaveBeenCalledTimes(1);
});

it("reveals the collapsed count only on hover or click/focus without shifting the heading", async () => {
  const screen = await render(
    <>
      <SidebarInyosiraGroupLabel state="present" isExpanded={false} onExpandedChange={vi.fn()} />
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
    <SidebarInyosiraGroupLabel state="later" isExpanded onExpandedChange={onExpandedChange} />,
  );
  const count = screen.getByText("(75)");
  await expect.element(count).toBeInTheDocument();
  await userEvent.keyboard("{Tab}{Enter}");
  await expect.poll(() => getComputedStyle(count.element()).opacity).toBe("1");
  expect(onExpandedChange).toHaveBeenCalledWith(false);
  await screen.rerender(
    <SidebarInyosiraGroupLabel
      state="later"
      isExpanded={false}
      onExpandedChange={onExpandedChange}
    />,
  );
  await expect.element(count).toBeInTheDocument();
  expect(api.request).toHaveBeenCalledTimes(1);
});

it("coalesces live membership changes and ignores streamed text", async () => {
  const screen = await render(
    <SidebarInyosiraGroupLabel state="later" isExpanded={false} onExpandedChange={vi.fn()} />,
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
    <SidebarInyosiraGroupLabel state="done" isExpanded onExpandedChange={vi.fn()} />,
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
      <SidebarInyosiraGroupLabel state="done" isExpanded onExpandedChange={vi.fn()} />,
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
    <SidebarInyosiraGroupLabel state="present" isExpanded onExpandedChange={vi.fn()} />,
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
    <SidebarInyosiraGroupLabel state="later" isExpanded onExpandedChange={vi.fn()} />,
  );
  await expect.element(screen.getByText("(…)")).toBeInTheDocument();
  await screen.rerender(
    <SidebarInyosiraGroupLabel state="done" isExpanded onExpandedChange={vi.fn()} />,
  );
  await expect.element(screen.getByText("(75)")).toBeInTheDocument();
  resolveOld({ totalCount: 99 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect.element(screen.getByText("(75)")).toBeInTheDocument();
  expect(api.unsubscribe).toHaveBeenCalledOnce();
});
