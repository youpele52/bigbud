import type { ThreadId } from "@bigbud/contracts";
import { ThreadId as Id } from "@bigbud/contracts";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const engagement = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../rpc/wsRpcClient.ts", () => ({
  getWsRpcClient: () => ({ organization: { engagement } }),
}));
import { useOrganizationEngagement } from "../../hooks/useOrganizationEngagement";
function View({ id }: { id: ThreadId }) {
  useOrganizationEngagement(id);
  return <div>thread</div>;
}
let now = 100000;
beforeEach(() => {
  now = 100000;
  engagement.mockClear();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => vi.restoreAllMocks());
it("renews only actual interaction at the bounded rate and releases on blur/unmount", async () => {
  const view = await render(<View id={Id.makeUnsafe("reading")} />);
  expect(engagement).toHaveBeenLastCalledWith({ threadId: "reading", engaged: true });
  document.dispatchEvent(new Event("scroll"));
  expect(engagement).toHaveBeenCalledTimes(1);
  now += 15000;
  document.dispatchEvent(new Event("scroll"));
  expect(engagement).toHaveBeenCalledTimes(2);
  vi.mocked(document.hasFocus).mockReturnValue(false);
  window.dispatchEvent(new Event("blur"));
  expect(engagement).toHaveBeenLastCalledWith({ threadId: "reading", engaged: false });
  now += 15000;
  document.dispatchEvent(new Event("input"));
  expect(engagement).toHaveBeenCalledTimes(3);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  expect(engagement).toHaveBeenCalledTimes(3);
  document.dispatchEvent(new Event("keydown"));
  expect(engagement).toHaveBeenLastCalledWith({ threadId: "reading", engaged: true });
  await view.unmount();
  expect(engagement).toHaveBeenLastCalledWith({ threadId: "reading", engaged: false });
});
it("does not protect a hidden view or let visibility changes alone renew a lease", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const view = await render(<View id={Id.makeUnsafe("hidden")} />);
  document.dispatchEvent(new Event("pointerdown"));
  expect(engagement).not.toHaveBeenCalled();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(engagement).not.toHaveBeenCalled();
  document.dispatchEvent(new Event("pointerdown"));
  expect(engagement).toHaveBeenLastCalledWith({ threadId: "hidden", engaged: true });
  await view.unmount();
});
