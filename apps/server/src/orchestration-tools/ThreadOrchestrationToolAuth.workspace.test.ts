import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  readThreadOrchestrationToolAuth,
  readThreadOrchestrationToolAuthByToken,
  renewThreadOrchestrationToolAuth,
  resolveThreadOrchestrationToolAuthPath,
  THREAD_ORCHESTRATION_TOOL_AUTH_TTL_MS,
} from "./ThreadOrchestrationToolAuth.ts";
import { prepareThreadOrchestrationSessionAuth } from "./threadOrchestrationBridge.shared.ts";

it("persists the issued workspace across reads and renewal without retaining a mutable input", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "workspace-auth-"));
  const owner = { stateDir, threadId: "workspace-owner" };
  const binding = { executionTargetId: "ssh:original", cwd: "/srv/original" };
  try {
    const { token } = await prepareThreadOrchestrationSessionAuth({
      ...owner,
      workspaceBinding: binding,
    });
    binding.cwd = "/srv/changed";
    const record = await readThreadOrchestrationToolAuthByToken({ stateDir, token });
    expect(record?.workspaceBinding).toEqual({
      executionTargetId: "ssh:original",
      cwd: "/srv/original",
    });
    await writeFile(
      resolveThreadOrchestrationToolAuthPath(owner),
      JSON.stringify({
        ...record,
        createdAt: new Date(
          Date.now() - THREAD_ORCHESTRATION_TOOL_AUTH_TTL_MS + 1000,
        ).toISOString(),
      }),
    );
    await renewThreadOrchestrationToolAuth({ ...owner, token });
    const renewed = await readThreadOrchestrationToolAuth(owner);
    expect(renewed?.workspaceBinding).toEqual(record?.workspaceBinding);
    expect(Date.parse(renewed!.createdAt)).toBeGreaterThan(Date.now() - 1000);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

it.each([null, {}, { executionTargetId: "ssh:vps" }, { executionTargetId: "ssh:vps", cwd: "" }])(
  "does not downgrade malformed binding %j to legacy unbound auth",
  async (workspaceBinding) => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "workspace-auth-"));
    const owner = { stateDir, threadId: "malformed-owner" };
    try {
      const { token } = await prepareThreadOrchestrationSessionAuth(owner);
      await writeFile(
        resolveThreadOrchestrationToolAuthPath(owner),
        JSON.stringify({
          threadId: owner.threadId,
          token,
          createdAt: new Date().toISOString(),
          workspaceBinding,
        }),
      );
      expect(await readThreadOrchestrationToolAuth(owner)).toBeNull();
      expect(await readThreadOrchestrationToolAuthByToken({ stateDir, token })).toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

it("keeps existing non-v2 issuers compatible when no binding is provided", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "workspace-auth-"));
  try {
    const { token } = await prepareThreadOrchestrationSessionAuth({ stateDir, threadId: "legacy" });
    expect(await readThreadOrchestrationToolAuthByToken({ stateDir, token })).toMatchObject({
      threadId: "legacy",
      token,
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
