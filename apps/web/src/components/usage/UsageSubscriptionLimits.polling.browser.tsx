import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import {
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState";
import { SUBSCRIPTION_REFRESH_INTERVAL_MS as interval } from "./UsageSubscriptionLimits.polling";
import { UsageSubscriptionLimitsRefresh } from "./UsageSubscriptionLimits.refresh";

const api = vi.hoisted(() => ({ refreshUsageLimits: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({ ensureNativeApi: () => ({ server: api }) }));

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  resetWsConnectionStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("pauses subscription reads in a hidden tab or during a disconnect and catches up once", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  api.refreshUsageLimits.mockResolvedValue({ providers: [], outcomes: [] });
  recordWsConnectionOpened();
  mounted = await render(
    <AppAtomRegistryProvider>
      <UsageSubscriptionLimitsRefresh visible>Subscription limits</UsageSubscriptionLimitsRefresh>
    </AppAtomRegistryProvider>,
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  await advance(interval);
  expect(api.refreshUsageLimits).not.toHaveBeenCalled();

  const setVisibility = (state: DocumentVisibilityState) =>
    act(async () => {
      visibility.mockReturnValue(state);
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await setVisibility("visible");
  expect(api.refreshUsageLimits).toHaveBeenCalledTimes(1);
  await setVisibility("hidden");
  await advance(2 * interval);
  expect(api.refreshUsageLimits).toHaveBeenCalledTimes(1);

  await act(async () => {
    recordWsConnectionClosed();
  });
  await setVisibility("visible");
  await advance(interval);
  expect(api.refreshUsageLimits).toHaveBeenCalledTimes(1);

  await act(async () => {
    recordWsConnectionOpened();
  });
  expect(api.refreshUsageLimits).toHaveBeenCalledTimes(2);
  await advance(interval - 1);
  expect(api.refreshUsageLimits).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(api.refreshUsageLimits).toHaveBeenCalledTimes(3);
});
