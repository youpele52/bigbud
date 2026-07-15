import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, TextGenerationError, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const mockBuildHandoffPrompt = vi.hoisted(() => vi.fn(() => "handoff prompt"));
const mockBuildThreadSnapshotMarkdown = vi.hoisted(() => vi.fn(() => "thread snapshot"));
const mockChunkMarkdown = vi.hoisted(() => vi.fn(() => ["thread snapshot"]));
const mockNormalizeHandoffModelSelection = vi.hoisted(() =>
  vi.fn(() => ({ provider: "codex" as const, model: "gpt-5.4-mini" })),
);
const mockResolveHandoffCwd = vi.hoisted(() => vi.fn(() => "/tmp/project"));
const mockGenerateClaudeHandoff = vi.hoisted(() => vi.fn());
const mockGenerateCodexHandoff = vi.hoisted(() => vi.fn());
const mockWriteHandoffDocumentFile = vi.hoisted(() => vi.fn());

vi.mock("./wsHandoffJobs.shared.ts", () => ({
  buildHandoffPrompt: mockBuildHandoffPrompt,
  buildThreadSnapshotMarkdown: mockBuildThreadSnapshotMarkdown,
  chunkMarkdown: mockChunkMarkdown,
  normalizeHandoffModelSelection: mockNormalizeHandoffModelSelection,
  resolveHandoffCwd: mockResolveHandoffCwd,
}));

vi.mock("./wsHandoffJobs.cli.ts", () => ({
  generateClaudeHandoff: mockGenerateClaudeHandoff,
  generateCodexHandoff: mockGenerateCodexHandoff,
}));

vi.mock("./wsHandoffDocument.ts", () => ({
  writeHandoffDocumentFile: mockWriteHandoffDocumentFile,
}));

import { makeServerHandoffJobs } from "./wsHandoffJobs.ts";

function makeSnapshot(threadId = ThreadId.makeUnsafe("thread-1")) {
  const projectId = ProjectId.makeUnsafe("project-1");
  return {
    projects: [{ id: projectId, workspaceRoot: "/tmp/project" }],
    threads: [{ id: threadId, title: "Thread title", projectId }],
  } as never;
}

function makeProjectionSnapshotQueryLayer(threadId?: ThreadId) {
  return Layer.succeed(ProjectionSnapshotQuery, {
    getSnapshot: () => Effect.succeed(makeSnapshot(threadId)),
    getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
    getUsageEntries: () => Effect.succeed([]),
    getUsageHistoryStatus: () => Effect.succeed("ready"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  });
}

async function createJobs(threadId?: ThreadId) {
  return Effect.runPromise(
    makeServerHandoffJobs.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettingsService.layerTest({
            textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
          }),
          makeProjectionSnapshotQueryLayer(threadId),
        ),
      ),
    ),
  );
}

async function waitForTerminalJobState(
  jobs: Awaited<ReturnType<typeof createJobs>>,
  jobId: string,
  attempts = 50,
) {
  for (let index = 0; index < attempts; index += 1) {
    const job = await Effect.runPromise(jobs.getJob(jobId));
    if (job.status === "succeeded" || job.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for handoff job '${jobId}' to finish.`);
}

describe("makeServerHandoffJobs", () => {
  beforeEach(() => {
    mockBuildHandoffPrompt.mockClear();
    mockBuildThreadSnapshotMarkdown.mockClear();
    mockChunkMarkdown.mockClear();
    mockNormalizeHandoffModelSelection.mockClear();
    mockResolveHandoffCwd.mockClear();
    mockGenerateClaudeHandoff.mockReset();
    mockGenerateCodexHandoff.mockReset();
    mockWriteHandoffDocumentFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes a queued job and writes the generated handoff document", async () => {
    mockGenerateCodexHandoff.mockImplementation(() => Effect.succeed("# Handoff\n\nBody"));
    mockWriteHandoffDocumentFile.mockResolvedValue("/tmp/handoff.md");

    const jobs = await createJobs();
    const started = await Effect.runPromise(
      jobs.startJob({
        threadId: ThreadId.makeUnsafe("thread-1"),
        focus: "Continue the migration",
      }),
    );
    const completed = await waitForTerminalJobState(jobs, started.jobId);

    expect(started.status).toBe("queued");
    expect(completed.status).toBe("succeeded");
    expect(completed.outputPath).toBe("/tmp/handoff.md");
    expect(mockGenerateCodexHandoff).toHaveBeenCalledTimes(1);
    expect(mockWriteHandoffDocumentFile).toHaveBeenCalledWith({
      title: "Thread title",
      content: "# Handoff\n\nBody",
    });
  });

  it("returns the existing in-flight job when the same thread is handed off twice", async () => {
    let resolveGeneration: ((value: string) => void) | null = null;
    mockGenerateCodexHandoff.mockImplementation(() =>
      Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            resolveGeneration = resolve;
          }),
      ),
    );
    mockWriteHandoffDocumentFile.mockResolvedValue("/tmp/handoff.md");

    const jobs = await createJobs();
    const firstJob = await Effect.runPromise(
      jobs.startJob({
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    const secondJob = await Effect.runPromise(
      jobs.startJob({
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );

    expect(secondJob.jobId).toBe(firstJob.jobId);
    expect(mockGenerateCodexHandoff).toHaveBeenCalledTimes(1);

    expect(resolveGeneration).not.toBeNull();
    resolveGeneration!("# Handoff\n\nBody");
    const completed = await waitForTerminalJobState(jobs, firstJob.jobId);
    expect(completed.status).toBe("succeeded");
  });

  it("marks the job as failed when generation errors", async () => {
    mockGenerateCodexHandoff.mockImplementation(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadHandoff",
          detail: "Codex handoff generation timed out.",
        }),
      ),
    );

    const jobs = await createJobs();
    const started = await Effect.runPromise(
      jobs.startJob({
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    const failed = await waitForTerminalJobState(jobs, started.jobId);

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Codex handoff generation timed out.");
    expect(mockWriteHandoffDocumentFile).not.toHaveBeenCalled();
  });
});
