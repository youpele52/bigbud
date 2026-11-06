import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it, vi } from "vitest";
import { acknowledgeThreadOpen } from "./threadOrganizationAcknowledge.ts";
const engagement = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../rpc/wsRpcClient.ts", () => ({
  getWsRpcClient: () => ({ organization: { engagement } }),
}));
it("opening grants engagement without dispatching an organisation move", () => {
  acknowledgeThreadOpen(ThreadId.makeUnsafe("thread-open"));
  expect(engagement).toHaveBeenCalledWith({ threadId: "thread-open", engaged: true });
});
