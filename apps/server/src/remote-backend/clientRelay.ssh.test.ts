import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  ready: vi.fn(async () => {}),
  trust: vi.fn(async () => {}),
  spawn: vi.fn(() => {
    throw new Error("Unexpected SSH process");
  }),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { makeClientRelaySshChannels } from "./clientRelay.ssh.ts";
const deployment = {
  nodeBinary: "/private/node",
  nodeSha256: "a".repeat(64),
  helperEntry: "/private/helper.mjs",
  helperSha256: "b".repeat(64),
  authorityId: "c".repeat(32),
};
beforeEach(() => {
  mocks.ready.mockReset().mockResolvedValue(undefined);
  mocks.trust.mockReset().mockResolvedValue(undefined);
  mocks.spawn.mockClear();
});
it("invalid deployment refuses before trust probes or process creation", () => {
  expect(() =>
    makeClientRelaySshChannels({
      executionTargetId: "ssh:fixture",
      deployment: { ...deployment, helperEntry: "relative" },
    }),
  ).toThrow();
  expect(mocks.ready).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
