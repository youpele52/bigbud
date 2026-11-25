import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectionProjectRepositoryShape } from "../persistence/Services/ProjectionProjects.ts";
import { sampleSshMonitor } from "../ssh/sshMonitor.ts";
import { runProcess } from "../utils/processRunner.ts";
import {
  forgetSshMonitorTarget,
  recordVerifiedSshMonitorTarget,
} from "../ssh/sshMonitor.connections.ts";
import { listConnectedSshMonitorsEffect, sampleSshMonitorEffect } from "./wsSshMonitor.ts";
import { makeSshMonitorHandlers } from "./wsSshMonitor.handlers.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";

vi.mock("../ssh/sshMonitor.ts", () => ({ sampleSshMonitor: vi.fn() }));
vi.mock("../utils/processRunner.ts", () => ({ runProcess: vi.fn() }));
const target = "ssh:host=authorized&user=deploy&auth=ssh-key";
const unverified = "ssh:host=unverified&auth=ssh-key";
const clientA = "server-one:1";
const clientB = "server-one:2";
const row = (
  workspaceExecutionTargetId: string,
  deletedAt: string | null = null,
  deletingAt: string | null = null,
  title = "Production",
) => ({
  workspaceExecutionTargetId,
  title,
  deletingAt,
  deletedAt,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  workspaceRoot: "/fixture",
});
const id = (value: string) => value as ProjectId;

function repository(
  saved: Record<string, ReturnType<typeof row>>,
): ProjectionProjectRepositoryShape {
  return {
    getById: ({ projectId }: { projectId: ProjectId }) =>
      Effect.succeed(saved[projectId] ? Option.some(saved[projectId]) : Option.none()),
    listAll: () =>
      Effect.succeed(
        Object.entries(saved).map(([key, project]) => ({
          projectId: id(key),
          title: project.title,
          workspaceExecutionTargetId: project.workspaceExecutionTargetId,
          deletingAt: project.deletingAt,
          deletedAt: project.deletedAt,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          workspaceRoot: project.workspaceRoot,
        })),
      ),
  } as unknown as ProjectionProjectRepositoryShape;
}

afterEach(() => {
  forgetSshMonitorTarget(target);
  forgetSshMonitorTarget(unverified);
  vi.mocked(sampleSshMonitor).mockReset();
  vi.mocked(runProcess).mockReset();
  vi.useRealTimers();
});

describe("SSH monitor server authorization", () => {
  it("cancels a selected list probe when its last RPC reader leaves and ignores late loss", async () => {
    const projects = repository({ first: row(target) });
    recordVerifiedSshMonitorTarget(target, clientA);
    const late = Promise.withResolvers<"unreachable">();
    const started = Promise.withResolvers<AbortSignal>();
    const sampleHealth = vi
      .fn<(id: string, signal: AbortSignal) => Promise<"reachable" | "unreachable">>()
      .mockImplementationOnce((_id, signal) => {
        started.resolve(signal);
        return late.promise;
      })
      .mockResolvedValue("reachable");
    const handlers = makeSshMonitorHandlers(
      { projectionProjectRepository: Option.some(projects), monitorInstanceId: "server-one" },
      {
        targetId: target,
        workspaceRoot: "/fixture",
        sampleHealth,
        subscribeStatus: () => ({
          id: 0,
          closed: true,
          drain: () => [],
          close: () => undefined,
        }),
        setStatusGeneration: () => undefined,
        closeStatus: () => undefined,
      },
    );
    const list = () => handlers[WS_METHODS.serverListConnectedSshMonitors]({}, { clientId: 1 });
    const abort = new AbortController();
    const cancelled = expect(
      Effect.runPromise(list(), { signal: abort.signal }),
    ).rejects.toBeDefined();
    const probe = await started.promise;
    abort.abort();
    await cancelled;
    expect(probe.aborted).toBe(true);
    const expected = [{ projectId: id("first"), name: "Production", target }];
    await expect(Effect.runPromise(list())).resolves.toEqual(expected);
    late.resolve("unreachable");
    await late.promise;
    await expect(Effect.runPromise(list())).resolves.toEqual(expected);
    expect(sampleHealth).toHaveBeenCalledTimes(2);
    expect(runProcess).not.toHaveBeenCalled();
    expect(sampleSshMonitor).not.toHaveBeenCalled();
  });
  it("fails closed when RPC metadata contains no server-assigned caller id", async () => {
    const projects = repository({ first: row(target) });
    const handlers = makeSshMonitorHandlers({
      projectionProjectRepository: Option.some(projects),
      monitorInstanceId: "server-one",
    } as unknown as WsRpcContext);
    recordVerifiedSshMonitorTarget(target, clientA);
    await expect(
      Effect.runPromise(handlers[WS_METHODS.serverSampleSshMonitor]({ projectId: id("first") })),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(handlers[WS_METHODS.serverListConnectedSshMonitors]({})),
    ).rejects.toBeDefined();
    expect(sampleSshMonitor).not.toHaveBeenCalled();
  });

  it("rejects unknown, deleted and unverified project ids without spawning SSH", async () => {
    const saved = repository({
      deleted: row(target, "2026-01-01"),
      deleting: row(target, null, "2026-01-01"),
      offline: row(unverified),
      malformed: row("ssh:host=-oProxyCommand=bad"),
    });
    recordVerifiedSshMonitorTarget(target, clientA);
    for (const projectId of ["unknown", "deleted", "deleting", "offline", "malformed"])
      await expect(
        Effect.runPromise(sampleSshMonitorEffect({ projectId: id(projectId) }, saved, clientA)),
      ).rejects.toBeDefined();
    expect(sampleSshMonitor).not.toHaveBeenCalled();
    await expect(
      Effect.runPromise(listConnectedSshMonitorsEffect(saved, clientA)),
    ).resolves.toEqual([]);
  });

  it("authorizes both saved projects sharing one verified target and ignores caller targets", async () => {
    const saved = repository({ first: row(target), second: row(target) });
    recordVerifiedSshMonitorTarget(target, clientA);
    vi.mocked(sampleSshMonitor).mockResolvedValue({
      summaryStatus: "ready",
      sampledAtMs: Date.now(),
    } as Awaited<ReturnType<typeof sampleSshMonitor>>);
    for (const projectId of ["first", "second"]) {
      const supplied = { projectId: id(projectId), executionTargetId: unverified };
      await expect(
        Effect.runPromise(sampleSshMonitorEffect(supplied, saved, clientA)),
      ).resolves.toContain("ready");
    }
    expect(sampleSshMonitor).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sampleSshMonitor).mock.calls.map(([value]) => value)).toEqual([
      target,
      target,
    ]);
    await expect(
      Effect.runPromise(listConnectedSshMonitorsEffect(saved, clientA)),
    ).resolves.toEqual([
      { projectId: id("first"), name: "Production", target },
      { projectId: id("second"), name: "Production", target },
    ]);
  });

  it("does not let another WebSocket connection inherit a verified target or discover it", async () => {
    const saved = repository({ first: row(target) });
    recordVerifiedSshMonitorTarget(target, clientA);
    await expect(
      Effect.runPromise(listConnectedSshMonitorsEffect(saved, clientB)),
    ).resolves.toEqual([]);
    await expect(
      Effect.runPromise(sampleSshMonitorEffect({ projectId: id("first") }, saved, clientB)),
    ).rejects.toBeDefined();
    expect(sampleSshMonitor).not.toHaveBeenCalled();
    recordVerifiedSshMonitorTarget(target, clientB);
    await expect(
      Effect.runPromise(listConnectedSshMonitorsEffect(saved, clientB)),
    ).resolves.toEqual([{ projectId: id("first"), name: "Production", target }]);
  });

  it("does not disclose a deleted project sharing a healthy target during discovery", async () => {
    const saved = {
      first: row(target, null, null, "Alpha"),
      second: row(target, null, null, "Beta"),
    };
    const base = repository(saved);
    let reads = 0;
    const projects = {
      ...base,
      listAll: () => {
        if (++reads === 2) saved.first = row(target, "2026-01-02", null, "Alpha");
        return base.listAll();
      },
    };
    recordVerifiedSshMonitorTarget(target, clientA);
    await expect(
      Effect.runPromise(listConnectedSshMonitorsEffect(projects, clientA)),
    ).resolves.toEqual([{ projectId: id("second"), name: "Beta", target }]);
  });

  it.each(["deleted", "retargeted", "disconnected", "reverified"] as const)(
    "rejects a sample if the workspace is %s while SSH sampling is in flight",
    async (change) => {
      const saved = { first: row(target) };
      const projects = repository(saved);
      recordVerifiedSshMonitorTarget(target, clientA);
      let finishSample: ((value: Awaited<ReturnType<typeof sampleSshMonitor>>) => void) | undefined;
      vi.mocked(sampleSshMonitor).mockImplementation(
        () =>
          new Promise((resolve) => {
            finishSample = resolve;
          }),
      );
      const result = Effect.runPromise(
        sampleSshMonitorEffect({ projectId: id("first") }, projects, clientA),
      );
      await vi.waitFor(() => expect(finishSample).toBeDefined());
      if (change === "deleted") saved.first = row(target, "2026-01-02");
      if (change === "retargeted") saved.first = row(unverified);
      if (change === "disconnected") forgetSshMonitorTarget(target);
      if (change === "reverified") recordVerifiedSshMonitorTarget(target, clientA);
      finishSample!({ summaryStatus: "ready", sampledAtMs: Date.now() } as Awaited<
        ReturnType<typeof sampleSshMonitor>
      >);
      await expect(result).rejects.toBeDefined();
    },
  );

  it("removes the selector on a failed key probe and does not expose cached data as live", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const saved = repository({ first: row(target) });
    recordVerifiedSshMonitorTarget(target, clientA);
    vi.mocked(sampleSshMonitor).mockResolvedValue({
      summaryStatus: "ready",
      sampledAtMs: 1_000,
    } as Awaited<ReturnType<typeof sampleSshMonitor>>);
    vi.mocked(runProcess).mockRejectedValue(new Error("temporary outage"));
    vi.setSystemTime(6_000);
    await expect(
      Effect.runPromise(listConnectedSshMonitorsEffect(saved, clientA)),
    ).resolves.toEqual([]);
    await expect(
      Effect.runPromise(sampleSshMonitorEffect({ projectId: id("first") }, saved, clientA)),
    ).rejects.toBeDefined();
    expect(sampleSshMonitor).not.toHaveBeenCalled();
  });
});
