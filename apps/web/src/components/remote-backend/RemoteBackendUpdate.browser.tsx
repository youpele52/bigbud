import "~/index.css";

import { Toast } from "@base-ui/react/toast";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { __resetBackendScopeForTests, setBackendScope } from "../../rpc/backendScope.state";
import type { RemoteRuntimeUpdateRpcMethods } from "../../rpc/wsRpcClient.remoteBackendUpdate";
import { toastManager } from "../ui/toast.manager";
import {
  APPROVAL,
  DIGEST_A,
  DIGEST_B,
  OPERATION_ID,
  handshake,
  operation,
  status,
  TURN,
  typedError,
} from "./RemoteBackendUpdate.test.fixtures";
import { RemoteBackendUpdateSection } from "./RemoteBackendUpdateSection";

const rpc = {
  requestRemoteRuntimeUpdate: vi.fn(),
  getRemoteRuntimeUpdateStatus: vi.fn(),
  consentRemoteRuntimeUpdateInterruption: vi.fn(),
  cancelRemoteRuntimeUpdate: vi.fn(),
};
const client = rpc as unknown as RemoteRuntimeUpdateRpcMethods;
const FAST = { live: 50, idle: 50 };

function ToastStatus() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <output key={toast.id} data-testid="update-toast" data-severity={toast.type}>
      {toast.title}
    </output>
  ));
}

function bind(runtimeUpdates: boolean) {
  setBackendScope(
    {
      kind: "bound",
      profileId: "vps-1",
      label: "Build VPS",
      http: { origin: "http://127.0.0.1:4100", headers: {} },
    },
    { api: {} as never, rpcClient: {} as never, readHandshake: () => handshake(runtimeUpdates) },
  );
}

const mount = () =>
  render(
    <Toast.Provider toastManager={toastManager} timeout={0}>
      <RemoteBackendUpdateSection client={client} localVersion="0.9.0" pollMs={FAST} />
      <ToastStatus />
    </Toast.Provider>,
  );

beforeEach(() => {
  for (const fn of Object.values(rpc)) fn.mockReset();
  rpc.getRemoteRuntimeUpdateStatus.mockResolvedValue(status(null));
});

afterEach(() => {
  __resetBackendScopeForTests();
  document.body.innerHTML = "";
});

describe("remote backend runtime update", () => {
  it("is hidden in a local window and never calls the backend", async () => {
    const screen = await mount();
    expect(screen.container.querySelector("section")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rpc.getRemoteRuntimeUpdateStatus).not.toHaveBeenCalled();
  });

  it("explains a bound backend without the runtimeUpdates capability", async () => {
    bind(false);
    await mount();
    await expect
      .element(page.getByTestId("remote-update-unavailable"))
      .toHaveTextContent("Not available on this backend");
    expect(rpc.getRemoteRuntimeUpdateStatus).not.toHaveBeenCalled();
  });

  it("requests an update and follows it to a deferral with honest reasons", async () => {
    bind(true);
    rpc.requestRemoteRuntimeUpdate.mockResolvedValue({
      disposition: "created",
      operation: operation("pending"),
    });
    await mount();
    await page.getByRole("button", { name: "Update to 0.9.0" }).click();
    expect(rpc.requestRemoteRuntimeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: "0.9.0", source: "release", interrupt: false }),
    );

    rpc.getRemoteRuntimeUpdateStatus.mockResolvedValue(status(operation("staging")));
    await expect.element(page.getByText("Preparing update", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Update to 0.9.0" })).toBeDisabled();

    rpc.getRemoteRuntimeUpdateStatus.mockResolvedValue(
      status(operation("deferred"), [TURN, APPROVAL]),
    );
    await expect.element(page.getByText("Update deferred", { exact: true })).toBeVisible();
    const reasons = page.getByRole("list", { name: "Blocking work" });
    await expect.element(reasons).toHaveTextContent("1 running turn");
    await expect.element(reasons).toHaveTextContent("1 pending approval");
    expect(
      document.querySelector('[data-update-state="deferred"]')?.getAttribute("data-status"),
    ).toBe("warning");
    await expect
      .element(page.getByTestId("update-toast").filter({ hasText: "Remote update deferred" }))
      .toHaveAttribute("data-severity", "warning");
    expect(rpc.consentRemoteRuntimeUpdateInterruption).not.toHaveBeenCalled();
  });

  it("lists the affected work and sends consent only on explicit confirmation", async () => {
    bind(true);
    rpc.getRemoteRuntimeUpdateStatus.mockResolvedValue(
      status(operation("deferred"), [TURN, APPROVAL], DIGEST_A),
    );
    rpc.requestRemoteRuntimeUpdate.mockResolvedValue({
      disposition: "joined",
      operation: operation("deferred", { interruptRequested: true }),
    });
    rpc.consentRemoteRuntimeUpdateInterruption.mockResolvedValue(
      operation("deferred", { interruptRequested: true, consent: "recorded" }),
    );
    await mount();
    await page.getByRole("button", { name: "Interrupt and update" }).click();
    expect(rpc.requestRemoteRuntimeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: "0.9.0", interrupt: true }),
    );
    const work = page.getByRole("list", { name: "Affected work" });
    await expect.element(work).toHaveTextContent(TURN.label);
    await expect.element(work).toHaveTextContent(APPROVAL.label);
    expect(rpc.consentRemoteRuntimeUpdateInterruption).not.toHaveBeenCalled();

    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Interrupt and update" })
      .click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(rpc.consentRemoteRuntimeUpdateInterruption).toHaveBeenCalledExactlyOnceWith({
      operationId: OPERATION_ID,
      affectedWorkDigest: DIGEST_A,
    });
  });

  it("re-fetches and asks again after stale consent, without resubmitting", async () => {
    bind(true);
    const deferred = operation("deferred", { interruptRequested: true });
    rpc.getRemoteRuntimeUpdateStatus.mockResolvedValue(status(deferred, [TURN], DIGEST_A));
    rpc.consentRemoteRuntimeUpdateInterruption
      .mockRejectedValueOnce(typedError("consent-stale"))
      .mockResolvedValueOnce({ ...deferred, consent: "recorded" });
    await mount();
    await page.getByRole("button", { name: "Interrupt and update" }).click();
    await expect
      .element(page.getByRole("list", { name: "Affected work" }))
      .toHaveTextContent(TURN.label);
    expect(rpc.requestRemoteRuntimeUpdate).not.toHaveBeenCalled();

    rpc.getRemoteRuntimeUpdateStatus.mockResolvedValue(
      status(deferred, [TURN, APPROVAL], DIGEST_B),
    );
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Interrupt and update" }).click();
    await expect.element(dialog.getByText(/running work changed/)).toBeVisible();
    await expect
      .element(page.getByRole("list", { name: "Affected work" }))
      .toHaveTextContent(APPROVAL.label);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(rpc.consentRemoteRuntimeUpdateInterruption).toHaveBeenCalledTimes(1);

    await dialog.getByRole("button", { name: "Interrupt and update" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    expect(rpc.consentRemoteRuntimeUpdateInterruption.mock.calls).toEqual([
      [{ operationId: OPERATION_ID, affectedWorkDigest: DIGEST_A }],
      [{ operationId: OPERATION_ID, affectedWorkDigest: DIGEST_B }],
    ]);
  });
});
