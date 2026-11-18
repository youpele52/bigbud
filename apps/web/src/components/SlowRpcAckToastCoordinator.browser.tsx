import "~/index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  acknowledgeRpcRequest,
  resetRequestLatencyStateForTests,
  setSlowRpcAckThresholdMsForTests,
  trackRpcRequestSent,
} from "../rpc/requestLatencyState";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState";
import { SlowRpcAckToastCoordinator } from "./SlowRpcAckToastCoordinator";
import { ToastProvider, toastManager } from "./ui/toast";
import { settleToastForPointer } from "./ui/toast.browser.utils";

const TITLE = "Some requests are slow";

afterEach(() => {
  toastManager.close();
  resetRequestLatencyStateForTests();
  resetWsConnectionStateForTests();
});

const waitForSlowTracking = () => new Promise((resolve) => setTimeout(resolve, 100));

it("closes on × and stays closed while the slow-request condition continues", async () => {
  recordWsConnectionAttempt("ws://localhost/ws");
  recordWsConnectionOpened();
  setSlowRpcAckThresholdMsForTests(20);
  const screen = await render(
    <AppAtomRegistryProvider>
      <ToastProvider>
        <SlowRpcAckToastCoordinator />
      </ToastProvider>
    </AppAtomRegistryProvider>,
  );
  trackRpcRequestSent("a", "orchestration.a");
  trackRpcRequestSent("b", "orchestration.b");
  await expect.element(screen.getByText("2 requests waiting longer than 0s.")).toBeVisible();

  const popup = screen
    .getByText(TITLE)
    .element()
    .closest<HTMLElement>('[data-slot="toast-popup"]')!;
  // Electron drag regions otherwise swallow clicks on cards over panel headers.
  expect(getComputedStyle(popup).getPropertyValue("-webkit-app-region")).toBe("no-drag");
  await settleToastForPointer(popup);
  await page
    .elementLocator(
      popup.querySelector<HTMLButtonElement>('button[aria-label="Close notification"]')!,
    )
    .click();
  await expect.element(screen.getByText(TITLE)).not.toBeInTheDocument();

  // The count keeps changing, then the condition clears and comes back.
  trackRpcRequestSent("c", "orchestration.c");
  acknowledgeRpcRequest("a");
  await waitForSlowTracking();
  acknowledgeRpcRequest("b");
  acknowledgeRpcRequest("c");
  trackRpcRequestSent("d", "orchestration.d");
  await waitForSlowTracking();
  expect(document.body.textContent).not.toContain(TITLE);
});
