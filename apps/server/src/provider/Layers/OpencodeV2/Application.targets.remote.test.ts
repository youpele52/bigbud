import { readFile, stat } from "node:fs/promises";
import { Effect } from "effect";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, expect, it, vi } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2StartAttempt } from "./Runtime.start.ts";
import { makeV2SharedTargetPreparation } from "./Application.targets.shared.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { v2InstructionEntries } from "./Runtime.instructions.ts";
import { readThreadOrchestrationToolAuthByToken } from "../../../orchestration-tools/ThreadOrchestrationToolAuth.ts";

const probe = vi.hoisted(() => vi.fn());
vi.mock("../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts", () => ({
  probeRemoteWorkspaceReadiness: probe,
}));
afterEach(() => {
  vi.restoreAllMocks();
  probe.mockReset();
});

const input = {
  threadId: ThreadId.makeUnsafe("remote-local-opencode"),
  cwd: "/srv/project",
  providerRuntimeExecutionTargetId: "local",
  workspaceExecutionTargetId: "ssh:vps",
  runtimeMode: "full-access" as const,
  modelSelection: {
    provider: "opencodeV2",
    subProviderID: "synthetic-provider",
    model: "synthetic-model",
  } as const,
};

it("starts a local shared session against remote tools, revokes credentials on stop and resumes the same native history", async () => {
  await withV2RuntimeFixture(async ({ runtime: baseline, http }) => {
    probe.mockResolvedValue({ os: "linux", architecture: "x86_64" });
    const catalogs = new Map<string, string>();
    const add = vi
      .spyOn(http.client.mcp, "add")
      .mockImplementation(async ({ location, server }) => {
        catalogs.set(location!.directory!, server);
      });
    vi.spyOn(http.client.mcp, "list").mockImplementation(async ({ location } = {}) => ({
      location: { directory: location!.directory! },
      data: catalogs.has(location!.directory!)
        ? [{ name: catalogs.get(location!.directory!)!, status: { status: "connected" } }]
        : [],
    }));
    const options = { ...sharedV2FixtureOptions(baseline, http), enableLocalTools: true };
    const prepareSession = makeV2SharedTargetPreparation(
      options,
      baseline.options.config.profileRoot,
      12345,
    );
    const runtime = new OpencodeV2Runtime({ ...options, prepareSession });
    let firstNative: string | undefined;
    let firstLocation: string | undefined;
    let firstToken: string | undefined;
    let firstScript: string | undefined;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await runtime.start(input);
        const owner = runtime.get(input.threadId);
        const remote = owner.resources!.remoteWorkspace!;
        const token = owner.resources!.orchestration!.token;
        expect(
          await readThreadOrchestrationToolAuthByToken({
            stateDir: baseline.options.config.profileRoot,
            token,
          }),
        ).toMatchObject({
          threadId: input.threadId,
          workspaceBinding: { executionTargetId: "ssh:vps", cwd: input.cwd },
        });
        const native = owner.native.id;
        expect(owner.session.providerRuntimeExecutionTargetId).toBe("local");
        expect(owner.session.workspaceExecutionTargetId).toBe("ssh:vps");
        expect(owner.native.location.directory).not.toBe(input.cwd);
        expect(probe).toHaveBeenLastCalledWith(
          expect.objectContaining({ cwd: input.cwd, executionTargetId: "ssh:vps" }),
        );
        const policy = owner.toolPolicy!;
        for (const action of [
          "read",
          "edit",
          "shell",
          "glob",
          "grep",
          "skill",
          "subagent",
          "unknown_plugin",
        ])
          expect(v2PermissionEffect(policy, action, "*")).toBe("deny");
        expect(v2PermissionEffect(policy, `${remote.serverName}_bash`, "*")).toBe("allow");
        expect(v2PermissionEffect(policy, `${remote.serverName}_write`, "*")).toBe("allow");
        expect(v2PermissionEffect(policy, "bbv2_remote_other_read", "*")).toBe("deny");
        expect(v2PermissionEffect(policy, "bigbud_thread_v1_create_thread", "*")).toBe("allow");
        expect(JSON.stringify(v2InstructionEntries(owner))).toContain("/srv/project");
        expect(JSON.stringify(v2InstructionEntries(owner))).toContain(
          "never fall back to local paths",
        );
        const registration = add.mock.calls.at(-1)![0];
        expect(registration.location?.directory).toBe(owner.native.location.directory);
        expect(registration.config.type).toBe("local");
        const command = registration.config.type === "local" ? registration.config.command : [];
        expect(await readFile(command[1]!, "utf8")).toContain(token);
        if (attempt) {
          expect(native).toBe(firstNative);
          expect(owner.native.location.directory).toBe(firstLocation);
          expect(token).not.toBe(firstToken);
          expect(command[1]).not.toBe(firstScript);
        }
        firstNative = native;
        firstLocation = owner.native.location.directory;
        firstToken = token;
        firstScript = command[1];
        await runtime.send({
          threadId: input.threadId,
          modelSelection: input.modelSelection,
          requestMessageId: MessageId.makeUnsafe(`remote-${attempt}`),
          input: "Inspect the VPS project.",
        });
        await expect.poll(() => owner.terminalDelivered).toBe(true);
        const row = await Effect.runPromise(options.journal.latestBound(input.threadId));
        expect(row?.binding).toMatchObject({
          runtimeTargetId: "local",
          workspaceTargetId: "ssh:vps",
          location: firstLocation,
        });
        await runtime.stop(input.threadId);
        expect(
          await readThreadOrchestrationToolAuthByToken({
            stateDir: baseline.options.config.profileRoot,
            token,
          }),
        ).toBeNull();
        await expect(stat(command[1]!)).rejects.toThrow();
        expect((await stat(firstLocation!)).isDirectory()).toBe(true);
      }
      expect(
        http.calls.filter((call) => call.method === "POST" && call.pathname === "/api/session"),
      ).toHaveLength(1);
      expect(add).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
  });
});

it("remote readiness failure never acquires native history or falls back to a local project", async () => {
  await withV2RuntimeFixture(async ({ runtime: baseline, http }) => {
    probe.mockRejectedValue(new Error("VPS is disconnected"));
    const options = { ...sharedV2FixtureOptions(baseline, http), enableLocalTools: true };
    const runtime = new OpencodeV2Runtime({
      ...options,
      prepareSession: makeV2SharedTargetPreparation(
        options,
        baseline.options.config.profileRoot,
        12345,
      ),
    });
    try {
      await expect(runtime.start(input)).rejects.toThrow("VPS is disconnected");
      expect(http.sessions.size).toBe(0);
      expect(http.calls).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});

it("a disconnected MCP registration cannot publish a usable session or submit a prompt", async () => {
  await withV2RuntimeFixture(async ({ runtime: baseline, http }) => {
    probe.mockResolvedValue({ os: "linux", architecture: "x86_64" });
    vi.spyOn(http.client.mcp, "add").mockResolvedValue(undefined);
    vi.spyOn(http.client.mcp, "list").mockImplementation(async ({ location } = {}) => ({
      location: { directory: location!.directory! },
      data: [],
    }));
    const options = { ...sharedV2FixtureOptions(baseline, http), enableLocalTools: true };
    const runtime = new OpencodeV2Runtime({
      ...options,
      prepareSession: makeV2SharedTargetPreparation(
        options,
        baseline.options.config.profileRoot,
        12345,
      ),
    });
    try {
      await expect(runtime.start(input)).rejects.toThrow(/unverified|timed out/);
      expect(runtime.sessions.size).toBe(0);
      expect(http.calls.some((call) => call.pathname.endsWith("/prompt"))).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});

it("cancelled bridge installation revokes its script and releases quarantine after physical completion", async () => {
  await withV2RuntimeFixture(async ({ runtime: baseline, http, directory }) => {
    probe.mockResolvedValue({ os: "linux", architecture: "x86_64" });
    let complete!: () => void;
    let script: string | undefined;
    const add = vi.spyOn(http.client.mcp, "add").mockImplementation(({ config }) => {
      script = config.type === "local" ? config.command[1] : undefined;
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    });
    const options = { ...sharedV2FixtureOptions(baseline, http), enableLocalTools: true };
    const runtime = new OpencodeV2Runtime({
      ...options,
      prepareSession: makeV2SharedTargetPreparation(
        options,
        baseline.options.config.profileRoot,
        12345,
      ),
    });
    const attempt = new V2StartAttempt();
    const started = runtime.start(input, attempt).catch((error: unknown) => error);
    try {
      await expect.poll(() => add.mock.calls.length).toBe(1);
      attempt.controller.abort(new Error("Cancelled remote startup"));
      expect(await started).toBeInstanceOf(Error);
      await expect(stat(script!)).rejects.toThrow();
      expect(runtime.mutations.busyCount()).toBe(1);
      complete();
      await expect.poll(() => runtime.mutations.busyCount()).toBe(0);
      await runtime.start({
        ...input,
        threadId: ThreadId.makeUnsafe("unrelated-local"),
        cwd: directory,
        workspaceExecutionTargetId: "local",
      });
      expect(runtime.sessions.size).toBe(1);
    } finally {
      complete?.();
      await runtime.close();
    }
  });
});
