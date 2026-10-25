import { expect, it, vi } from "vitest";
import {
  installV2NativeSubagentGuard,
  type V2NativeGuardContext,
  type V2NativeGuardAuthority,
} from "./Subagents.plugin.ts";
import type { guardedV2SubagentExecutor } from "./Subagents.guard.ts";

it("installs the exact native executor/progress, permission and background-wake boundaries without replacing native execution", async () => {
  const hooks = new Map<string, (value: never) => Promise<void>>();
  const dispose = vi.fn(async () => {});
  type Executor = Parameters<typeof guardedV2SubagentExecutor>[0];
  const native = vi.fn<Executor>(async (_input, context) => {
    await context.progress({ sessionID: "ses_child" });
    return { output: { sessionID: "ses_child", status: "running", output: "native output" } };
  });
  const tool: { execute: Executor } = { execute: native };
  const ctx: V2NativeGuardContext = {
    tool: {
      transform: async (edit) => {
        edit({
          update: (id, update) => {
            expect(id).toBe("subagent");
            update(tool);
          },
        });
        return { dispose };
      },
    },
    permission: {
      hook: async (name, run) => {
        hooks.set(name, run as never);
        return { dispose };
      },
    },
    session: {
      hook: async (name, run) => {
        hooks.set(name, run as never);
        return { dispose };
      },
    },
  };
  let fenced = false;
  const authority: V2NativeGuardAuthority = {
    owns: async (id) => id !== "ses_unrelated",
    assertCurrent: async () => {
      if (fenced) throw new Error("Stop fence");
    },
    captureCurrent: () => () => {
      if (fenced) throw new Error("Stop fence");
    },
    beforePrompt: vi.fn(async () => {}),
    beforeSpawn: vi.fn(async () => {}),
    policy: async () => ({
      parent: [{ action: "*", resource: "*", effect: "allow" }],
      agent: [{ action: "shell", resource: "*", effect: "deny" }],
      overlay: [],
    }),
  };
  const release = await installV2NativeSubagentGuard(ctx, authority);
  const context = {
    sessionID: "ses_root",
    messageID: "msg_root",
    id: "call_root",
    signal: new AbortController().signal,
    progress: vi.fn(async () => {}),
  };
  const result = await tool.execute(
    { agent: "explore", description: "Offline assignment", prompt: "offline" },
    context,
  );
  expect(result).toMatchObject({
    output: { sessionID: "ses_child", status: "running", output: "native output" },
  });
  expect(authority.beforePrompt).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionID: "ses_child",
      parentSessionID: "ses_root",
      messageID: "msg_root",
      callID: "call_root",
    }),
  );
  expect(native).toHaveBeenCalledOnce();
  const permission = {
    sessionID: "ses_child",
    action: "shell",
    resources: ["echo offline"],
    effect: "allow",
  };
  await hooks.get("evaluate")!(permission as never);
  expect(permission.effect).toBe("deny");
  fenced = true;
  await expect(hooks.get("context")!({ sessionID: "ses_root" } as never)).rejects.toThrow(
    "Stop fence",
  );
  await expect(
    hooks.get("context")!({ sessionID: "ses_unrelated" } as never),
  ).resolves.toBeUndefined();
  await release();
  expect(dispose).toHaveBeenCalledTimes(3);
});
