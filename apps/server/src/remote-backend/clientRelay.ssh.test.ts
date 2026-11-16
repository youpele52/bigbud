import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  ready: vi.fn(async () => {}),
  trust: vi.fn(async () => {}),
  spawn: vi.fn(() => {
    throw new Error("Unexpected SSH process");
  }),
}));
vi.mock("../ssh/sshVerification.ts", () => ({ assertSshExecutionTargetReadyAsync: mocks.ready }));
vi.mock("../ssh/sshHostTrust.ts", () => ({ inspectSshHostTrust: mocks.trust }));
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
it("existing host trust refusal cannot spawn an SSH channel", async () => {
  mocks.trust.mockRejectedValueOnce(new Error("Host key changed"));
  const owner = makeClientRelaySshChannels({ executionTargetId: "ssh:fixture", deployment });
  await expect(owner.openChannel(new AbortController().signal)).rejects.toThrow("Host key changed");
  expect(mocks.spawn).not.toHaveBeenCalled();
  owner.dispose();
});
it("disposal while existing readiness is pending prevents even the later trust probe", async () => {
  let release!: () => void;
  mocks.ready.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const owner = makeClientRelaySshChannels({ executionTargetId: "ssh:fixture", deployment });
  const opening = owner.openChannel(new AbortController().signal);
  owner.dispose();
  release();
  await expect(opening).rejects.toThrow("disposed");
  expect(mocks.trust).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
it("abort during host verification cannot start a late SSH child", async () => {
  const controller = new AbortController();
  mocks.trust.mockImplementationOnce(async () => {
    controller.abort();
  });
  const owner = makeClientRelaySshChannels({ executionTargetId: "ssh:fixture", deployment });
  await expect(owner.openChannel(controller.signal)).rejects.toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled();
  owner.dispose();
});
