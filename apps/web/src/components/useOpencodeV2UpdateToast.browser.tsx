import type { ServerProvider } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useOpencodeV2UpdateToast } from "./useOpencodeV2UpdateToast";
import { toastManager } from "./ui/toast";

vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));
function NoticeHarness({ provider }: { provider: ServerProvider }) {
  useOpencodeV2UpdateToast([provider]);
  return (
    <span>
      {provider.status} / {provider.auth.status}
    </span>
  );
}

it("keeps qualified older runtime ready and emits one nonblocking amber notice across refresh, auth change and remount", async () => {
  const provider: ServerProvider = {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "2.0.24",
    runtimeUpdateRecommended: "2.0.26",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-10-09T00:00:00Z",
    models: [],
    skills: [],
    slashCommands: [],
    supportsLocalRuntimeRemoteWorkspace: false,
  };
  const first = await render(<NoticeHarness provider={{ ...provider, status: "warning" }} />);
  expect(toastManager.add).not.toHaveBeenCalled();
  await first.rerender(<NoticeHarness provider={provider} />);
  await expect.element(page.getByText("ready / unknown", { exact: true })).toBeInTheDocument();
  expect(toastManager.add).toHaveBeenCalledTimes(1);
  expect(toastManager.add).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      description: expect.stringContaining("current service remains usable"),
    }),
  );
  await first.rerender(
    <NoticeHarness
      provider={{
        ...provider,
        auth: { status: "authenticated", label: "Native OpenAI" },
        checkedAt: "2026-10-09T00:00:15Z",
      }}
    />,
  );
  await expect
    .element(page.getByText("ready / authenticated", { exact: true }))
    .toBeInTheDocument();
  await first.unmount();
  const second = await render(<NoticeHarness provider={provider} />);
  expect(toastManager.add).toHaveBeenCalledTimes(1);
  await second.unmount();
});
