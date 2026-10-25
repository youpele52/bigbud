import { WS_METHODS } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import { bindTerminalLaunch, readTerminalLaunch } from "../../../../lib/terminalLaunchBinding";
import { useTerminalStateStore } from "../../../../stores/terminal";
import { createChatViewBrowserTestContext } from "./context";
import { waitForElement } from "./dom";
import { DEFAULT_VIEWPORT, THREAD_ID } from "./fixtures";
import { buildWorktreeSnapshot, withProjectScripts } from "./scenarioFixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();
const worktree = "/repo/worktrees/feature-branch";
const env = { T3CODE_PROJECT_ROOT: "/repo/project", T3CODE_WORKTREE_PATH: worktree };

function setupRetainedTerminal(context: {
  cwd: string;
  worktreePath: string | null;
  executionTargetId: string;
  runtimeEnv: Record<string, string>;
}) {
  useTerminalStateStore.setState({
    terminalStateByThreadId: {
      [THREAD_ID]: {
        terminalOpen: false,
        terminalHeight: 280,
        terminalIds: ["default"],
        runningTerminalIds: [],
        activeTerminalId: "default",
        terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
        activeTerminalGroupId: "group-default",
      },
    },
  });
  return bindTerminalLaunch(THREAD_ID, "default", context);
}

function scriptSnapshot() {
  return withProjectScripts(buildWorktreeSnapshot(THREAD_ID), [
    {
      id: "lint",
      name: "Lint",
      command: "bun run lint",
      icon: "lint",
      runOnWorktreeCreate: false,
    },
  ]);
}

async function clickScript() {
  const button = await waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find((entry) => entry.title === "Run Lint") ??
      null,
    "Unable to find project script button.",
  );
  button.click();
}

describe("ChatView project scripts and retained terminal launches", () => {
  it.each([
    {
      name: "draft root before first-send worktree",
      context: {
        cwd: "/repo/project",
        worktreePath: null,
        executionTargetId: "local",
        runtimeEnv: { T3CODE_PROJECT_ROOT: "/repo/project" },
      },
    },
    {
      name: "previous SSH target",
      context: {
        cwd: worktree,
        worktreePath: worktree,
        executionTargetId: "ssh:old",
        runtimeEnv: env,
      },
    },
  ])("does not write project scripts into an idle terminal from $name", async ({ context }) => {
    const retained = setupRetainedTerminal(context);
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: scriptSnapshot(),
    });
    try {
      await clickScript();
      await vi.waitFor(() => {
        const write = ctx.wsRequests.find(
          (request) =>
            request._tag === WS_METHODS.terminalWrite && request.data === "bun run lint\r",
        );
        expect(write).toBeDefined();
        expect(write?.terminalId).not.toBe("default");
        expect(
          ctx.wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalOpen && request.terminalId === write?.terminalId,
          ),
        ).toMatchObject({ cwd: worktree, worktreePath: worktree, executionTargetId: "local", env });
      });
      expect(readTerminalLaunch(THREAD_ID, "default")).toEqual(retained);
      expect(
        ctx.wsRequests.some(
          (request) =>
            request._tag === WS_METHODS.terminalRestart ||
            request._tag === WS_METHODS.terminalClose,
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("can reuse a matching explicit launch context", async () => {
    setupRetainedTerminal({
      cwd: worktree,
      worktreePath: worktree,
      executionTargetId: "local",
      runtimeEnv: env,
    });
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: scriptSnapshot(),
    });
    try {
      await clickScript();
      await vi.waitFor(() =>
        expect(
          ctx.wsRequests.find(
            (request) =>
              request._tag === WS_METHODS.terminalWrite && request.data === "bun run lint\r",
          ),
        ).toMatchObject({ terminalId: "default" }),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(["fallback", "target mismatch"])(
    "verifies the actual returned snapshot and refuses writes on %s",
    async (failure) => {
      const mounted = await ctx.mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: scriptSnapshot(),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.terminalOpen
            ? {
                threadId: body.threadId,
                terminalId: body.terminalId,
                dropPathMode: "posix",
                status: "running",
                pid: 123,
                cwd: failure === "fallback" ? "/home/target" : body.cwd,
                worktreePath: failure === "fallback" ? null : body.worktreePath,
                executionTargetId: failure === "fallback" ? body.executionTargetId : "ssh:wrong",
                runtimeEnv: failure === "fallback" ? {} : body.env,
                ...(failure === "fallback"
                  ? {
                      directoryFallback: {
                        requestedCwd: body.cwd,
                        reason: "The requested folder does not exist",
                      },
                    }
                  : {}),
                history: "",
                exitCode: null,
                exitSignal: null,
                updatedAt: "2026-10-11T00:00:00.000Z",
              }
            : undefined,
      });
      try {
        await clickScript();
        await vi.waitFor(() =>
          expect(document.body.textContent).toContain("Project commands were not run"),
        );
        expect(
          ctx.wsRequests.some(
            (request) =>
              request._tag === WS_METHODS.terminalWrite && request.data === "bun run lint\r",
          ),
        ).toBe(false);
        expect(
          ctx.wsRequests.some(
            (request) =>
              request._tag === WS_METHODS.terminalClose ||
              request._tag === WS_METHODS.terminalRestart,
          ),
        ).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    },
  );
});
