import { ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useInyosiraStore } from "../../stores/inyosira/inyosira.store";
import { useInyosiraCatalog } from "./Sidebar.inyosira.catalog";

const api = vi.hoisted(() => ({ request: vi.fn(), append: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { getOrganizationThreadSummaries: api.request } }),
}));
vi.mock("../../stores/main", () => ({
  useStore: { getState: () => ({ appendOrganizationPage: api.append }) },
}));

const original = useInyosiraStore.getState();
const cursor = { updatedAt: "2026-11-03T12:00:00.000Z", threadId: ThreadId.makeUnsafe("cursor") };

function CatalogHarness() {
  const { pages, loadMore } = useInyosiraCatalog(true);
  return (
    <>
      <output>{pages.present.status}</output>
      <button onClick={() => loadMore("present")}>Load</button>
    </>
  );
}

beforeEach(() => {
  api.request.mockReset();
  api.append.mockReset();
  useInyosiraStore.setState({ ...original, collapsedStates: ["needs-you", "later", "done"] });
  useInyosiraStore.getState().setPage("present", {
    status: "idle",
    nextCursor: null,
    staleVersion: 0,
  });
});
afterEach(() => useInyosiraStore.setState(original));

it("retries a failed first page without a cursor", async () => {
  api.request.mockRejectedValueOnce(new Error("Disconnected"));
  const screen = await render(<CatalogHarness />);
  await expect.element(screen.getByText("error", { exact: true })).toBeInTheDocument();
  api.request.mockResolvedValue({ threads: [] });
  await screen.getByRole("button", { name: "Load" }).click();
  await expect.element(screen.getByText("loaded", { exact: true })).toBeInTheDocument();
  expect(api.request.mock.calls).toEqual([[{ state: "present" }], [{ state: "present" }]]);
  expect(api.append).toHaveBeenCalledOnce();
});

it("retains the paging cursor after failure and retries that same page", async () => {
  api.request.mockResolvedValueOnce({ threads: [], nextCursor: cursor });
  const screen = await render(<CatalogHarness />);
  await expect.element(screen.getByText("loaded", { exact: true })).toBeInTheDocument();
  api.request.mockRejectedValueOnce(new Error("Disconnected"));
  await screen.getByRole("button", { name: "Load" }).click();
  await expect.element(screen.getByText("error", { exact: true })).toBeInTheDocument();
  expect(useInyosiraStore.getState().pages.present.nextCursor).toEqual(cursor);
  api.request.mockResolvedValueOnce({ threads: [] });
  await screen.getByRole("button", { name: "Load" }).click();
  await expect.element(screen.getByText("loaded", { exact: true })).toBeInTheDocument();
  expect(api.request.mock.calls.slice(1)).toEqual([
    [{ state: "present", cursor }],
    [{ state: "present", cursor }],
  ]);
  expect(useInyosiraStore.getState().pages.present.nextCursor).toBeNull();
  await screen.getByRole("button", { name: "Load" }).click();
  expect(api.request).toHaveBeenCalledTimes(3);
});
