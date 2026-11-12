import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestNewThreadTitle } from "./Sidebar.threadActions.generation";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  retry: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    dialogs: { confirm: mocks.confirm },
    server: { retryTextGeneration: mocks.retry },
  }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
const threadId = ThreadId.makeUnsafe("explicit-title");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.retry.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "handles confirmation=%s without native randomUUID on HTTP origins",
  async (confirmed) => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(crypto.randomUUID).toBeUndefined();
    mocks.confirm.mockResolvedValue(confirmed);

    await requestNewThreadTitle(threadId);

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    if (!confirmed) {
      expect(mocks.retry).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
      return;
    }
    expect(mocks.retry).toHaveBeenCalledExactlyOnceWith({
      threadId,
      operation: "title",
      newRequestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      acknowledgeHistoricalUncertainty: "authorize-new-budget-with-unresolved-history",
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "Title generation requested" }),
    );
  },
);

it("declining the duplicate-cost warning does not request generation", async () => {
  mocks.confirm.mockResolvedValue(false);
  await requestNewThreadTitle(threadId);
  expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("duplicate cost"));
  expect(mocks.retry).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("sends explicit consent and a stable request identity, reporting requested rather than done", async () => {
  await requestNewThreadTitle(threadId);
  expect(mocks.retry).toHaveBeenCalledExactlyOnceWith({
    threadId,
    operation: "title",
    newRequestId: expect.any(String),
    acknowledgeHistoricalUncertainty: "authorize-new-budget-with-unresolved-history",
  });
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "info", title: "Title generation requested" }),
  );
});

it("suppresses duplicate clicks while confirmation or queueing is pending", async () => {
  let confirm!: (value: boolean) => void;
  mocks.confirm.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
  );
  const first = requestNewThreadTitle(threadId);
  await requestNewThreadTitle(threadId);
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  confirm(true);
  await first;
  expect(mocks.retry).toHaveBeenCalledTimes(1);
});

it("reports queue failures and releases the pending guard", async () => {
  mocks.retry.mockRejectedValueOnce(new Error("Known unsettled work"));
  await requestNewThreadTitle(threadId);
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", description: "Known unsettled work" }),
  );
  await requestNewThreadTitle(threadId);
  expect(mocks.retry).toHaveBeenCalledTimes(2);
});
