import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { forgetSshMonitorTarget, sshMonitorLease } from "../ssh/sshMonitor.connections.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { verifyExecutionTargetEffect } from "./wsExecutionTargetVerification.ts";
import { verifyAndAdmitSshMonitorTarget } from "./wsSshMonitor.verify.ts";

vi.mock("./wsExecutionTargetVerification.ts", () => ({ verifyExecutionTargetEffect: vi.fn() }));
const target = "ssh:host=verified&auth=ssh-key";
afterEach(() => {
  forgetSshMonitorTarget(target);
  vi.mocked(verifyExecutionTargetEffect).mockReset();
});

it("admits only the server-assigned connection that successfully verified SSH", async () => {
  const context = { monitorInstanceId: "server-one" } as unknown as WsRpcContext;
  const input = { executionTargetId: target };
  vi.mocked(verifyExecutionTargetEffect).mockReturnValue(
    Effect.succeed({
      executionTargetId: target,
      message: "SSH verified",
    }) as ReturnType<typeof verifyExecutionTargetEffect>,
  );
  await Effect.runPromise(verifyAndAdmitSshMonitorTarget(input, context, 1));
  expect(sshMonitorLease(target, "server-one:1")).not.toBeNull();
  expect(sshMonitorLease(target, "server-one:2")).toBeNull();
  expect(sshMonitorLease(target, "server-two:1")).toBeNull();
  await Effect.runPromise(verifyAndAdmitSshMonitorTarget(input, context));
  expect(sshMonitorLease(target, "server-one:2")).toBeNull();
});

it("does not admit a target when verification fails", async () => {
  const context = { monitorInstanceId: "server-one" } as unknown as WsRpcContext;
  vi.mocked(verifyExecutionTargetEffect).mockReturnValue(
    Effect.fail("SSH denied") as unknown as ReturnType<typeof verifyExecutionTargetEffect>,
  );
  await expect(
    Effect.runPromise(verifyAndAdmitSshMonitorTarget({ executionTargetId: target }, context, 1)),
  ).rejects.toBeDefined();
  expect(sshMonitorLease(target, "server-one:1")).toBeNull();
});
