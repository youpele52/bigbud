import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { MetadataGenerationWarning } from "@bigbud/contracts/orchestration/orchestration.metadataGeneration.ts";
import { METADATA_WARNING_CLAIM_MS } from "@bigbud/contracts/server/metadataWarnings.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMetadataWarningDelivery,
  metadataWarningToast,
} from "./MetadataWarningToastCoordinator.logic";

const warning = (id = "warning-1"): MetadataGenerationWarning => ({
  id,
  configEpoch: "epoch-1",
  threadId: ThreadId.makeUnsafe("thread-1"),
  operation: "title",
  createdAt: "2026-11-09T00:00:00.000Z",
  primaryFailures: 3,
});
const makeApi = () => ({
  claimMetadataWarnings: vi.fn(async () => [warning()]),
  acknowledgeMetadataWarning: vi.fn(async () => true),
});
const active = () => true;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

afterEach(() => vi.restoreAllMocks());

describe("metadata warning delivery", () => {
  it("displays before acknowledgment and retains identity/dedup across reconnect polls", async () => {
    const api = makeApi();
    const show = vi.fn();
    api.acknowledgeMetadataWarning.mockImplementation(async () => {
      expect(show).toHaveBeenCalledExactlyOnceWith(warning());
      return true;
    });
    const consumer = createMetadataWarningDelivery("renderer");
    await consumer.poll(api, show, active);
    await consumer.poll(api, show, active);
    expect(api.claimMetadataWarnings).toHaveBeenNthCalledWith(2, { clientId: "renderer" });
    expect(api.acknowledgeMetadataWarning).toHaveBeenNthCalledWith(2, {
      clientId: "renderer",
      warningId: "warning-1",
    });
    expect(show).toHaveBeenCalledOnce();
  });

  it("retries lost and refused acknowledgments without displaying again", async () => {
    const api = makeApi();
    api.acknowledgeMetadataWarning
      .mockRejectedValueOnce(new Error("lost ack"))
      .mockResolvedValueOnce(false);
    const show = vi.fn();
    const consumer = createMetadataWarningDelivery("renderer");
    for (let index = 0; index < 3; index += 1) await consumer.poll(api, show, active);
    expect(show).toHaveBeenCalledOnce();
    expect(api.acknowledgeMetadataWarning).toHaveBeenCalledTimes(3);
  });

  it("allows retry after a failed claim without marking anything delivered", async () => {
    const api = makeApi();
    api.claimMetadataWarnings.mockRejectedValueOnce(new Error("disconnected"));
    const show = vi.fn();
    const consumer = createMetadataWarningDelivery("renderer");
    await expect(consumer.poll(api, show, active)).rejects.toThrow("disconnected");
    expect(api.acknowledgeMetadataWarning).not.toHaveBeenCalled();
    await consumer.poll(api, show, active);
    expect(show).toHaveBeenCalledOnce();
  });

  it("serializes polls, including an old request during a reconnect", async () => {
    const api = makeApi();
    const response = deferred<MetadataGenerationWarning[]>();
    api.claimMetadataWarnings.mockReturnValueOnce(response.promise);
    const show = vi.fn();
    const consumer = createMetadataWarningDelivery("renderer");
    let connected = true;
    const pending = consumer.poll(api, show, () => connected);
    connected = false;
    await consumer.poll(api, show, active);
    expect(api.claimMetadataWarnings).toHaveBeenCalledOnce();
    response.resolve([warning()]);
    await pending;
    expect(show).not.toHaveBeenCalled();
    expect(api.acknowledgeMetadataWarning).not.toHaveBeenCalled();
    await consumer.poll(api, show, active);
    expect(show).toHaveBeenCalledOnce();
  });

  it("does not request while inactive or acknowledge a toast that failed to display", async () => {
    const api = makeApi();
    const consumer = createMetadataWarningDelivery("renderer");
    await consumer.poll(api, vi.fn(), () => false);
    expect(api.claimMetadataWarnings).not.toHaveBeenCalled();
    await expect(
      consumer.poll(
        api,
        () => {
          throw new Error("no toast");
        },
        active,
      ),
    ).rejects.toThrow("no toast");
    expect(api.acknowledgeMetadataWarning).not.toHaveBeenCalled();
    const show = vi.fn();
    await consumer.poll(api, show, active);
    expect(show).toHaveBeenCalledOnce();
  });

  it("discards delayed claims that may have expired before the response arrived", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const api = makeApi();
    const response = deferred<MetadataGenerationWarning[]>();
    api.claimMetadataWarnings.mockReturnValueOnce(response.promise);
    const show = vi.fn();
    const consumer = createMetadataWarningDelivery("renderer");
    const pending = consumer.poll(api, show, active);
    now = METADATA_WARNING_CLAIM_MS;
    response.resolve([warning()]);
    await pending;
    expect(show).not.toHaveBeenCalled();
    expect(api.acknowledgeMetadataWarning).not.toHaveBeenCalled();
    await consumer.poll(api, show, active);
    expect(show).toHaveBeenCalledOnce();
  });

  it.each([METADATA_WARNING_CLAIM_MS, -1])(
    "discards a claim after a local wall-clock change of %s ms while monotonic time is paused",
    async (change) => {
      let wallNow = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => wallNow);
      vi.spyOn(performance, "now").mockReturnValue(0);
      const api = makeApi();
      const response = deferred<MetadataGenerationWarning[]>();
      api.claimMetadataWarnings.mockReturnValueOnce(response.promise);
      const show = vi.fn();
      const consumer = createMetadataWarningDelivery("renderer");
      const pending = consumer.poll(api, show, active);
      wallNow += change;
      response.resolve([warning()]);
      await pending;
      expect(show).not.toHaveBeenCalled();
      expect(api.acknowledgeMetadataWarning).not.toHaveBeenCalled();
      await consumer.poll(api, show, active);
      expect(show).toHaveBeenCalledOnce();
    },
  );

  it("rechecks connection and lease before displaying each item in a claimed batch", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const api = makeApi();
    api.claimMetadataWarnings.mockResolvedValue([warning(), warning("warning-2")]);
    api.acknowledgeMetadataWarning.mockImplementation(async () => {
      now = METADATA_WARNING_CLAIM_MS;
      return true;
    });
    const show = vi.fn();
    await createMetadataWarningDelivery("renderer").poll(api, show, active);
    expect(show).toHaveBeenCalledExactlyOnceWith(warning());
    expect(api.acknowledgeMetadataWarning).toHaveBeenCalledOnce();
  });

  it("bounds dedup memory while retaining the newest 100 stable IDs", async () => {
    const api = makeApi();
    const show = vi.fn();
    const consumer = createMetadataWarningDelivery("renderer");
    for (let index = 0; index < 101; index += 1) {
      api.claimMetadataWarnings.mockResolvedValue([warning(`warning-${index}`)]);
      await consumer.poll(api, show, active);
    }
    await consumer.poll(api, show, active);
    expect(show).toHaveBeenCalledTimes(101);
    api.claimMetadataWarnings.mockResolvedValue([warning("warning-0")]);
    await consumer.poll(api, show, active);
    expect(show).toHaveBeenCalledTimes(102);
  });
});

it.each([0, 1])("uses factual unavailable wording for %s failures", (primaryFailures) => {
  const openSettings = vi.fn();
  const toast = metadataWarningToast({ ...warning(), primaryFailures }, openSettings);
  expect(toast).toMatchObject({ type: "warning", timeout: 0 });
  expect(toast.description).toContain("cannot currently be used");
  expect(toast.description).not.toContain("failed three");
  toast.actionProps!.onClick();
  expect(openSettings).toHaveBeenCalledOnce();
});

it.each([2, 3])(
  "uses a stable amber warning after the budget is exhausted (%s)",
  (primaryFailures) => {
    const openSettings = vi.fn();
    const toast = metadataWarningToast({ ...warning(), primaryFailures }, openSettings);
    expect(toast).toMatchObject({ id: "warning-1", type: "warning", timeout: 0 });
    expect(toast.description).toContain("exhausted its attempts");
    expect(toast.description).not.toMatch(/account|subscription|token|authentication/i);
    toast.actionProps!.onClick();
    expect(openSettings).toHaveBeenCalledOnce();
  },
);

it.each(["title", "summary"] as const)("offers only the final %s recovery action", (operation) => {
  const openSettings = vi.fn();
  const rename = vi.fn();
  const toast = metadataWarningToast(
    { ...warning(), kind: "final", operation },
    openSettings,
    rename,
  );
  expect(toast.type).toBe("warning");
  expect(toast.title).toBe(
    operation === "title"
      ? "This thread couldn't be named automatically. Rename it, or ask the agent in the thread to do it."
      : "This thread's summary couldn't be created automatically. Ask the agent in the thread to write one.",
  );
  expect(toast.description).toBeUndefined();
  if (operation === "title") {
    expect(toast.actionProps?.children).toBe("Rename");
    toast.actionProps?.onClick();
    expect(rename).toHaveBeenCalledOnce();
  } else expect(toast.actionProps).toBeUndefined();
  expect(openSettings).not.toHaveBeenCalled();
});
