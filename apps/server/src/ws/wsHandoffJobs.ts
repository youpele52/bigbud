import { Cause, Effect, FileSystem } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  ServerHandoffJobError,
  type ServerHandoffJob,
  type ServerStartHandoffJobInput,
} from "@bigbud/contracts";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { writeHandoffDocumentFile } from "./wsHandoffDocument";
import { resolveDefaultChatCwd, ServerSettingsService } from "./serverSettings.ts";
import {
  buildHandoffPrompt,
  buildThreadSnapshotMarkdown,
  chunkMarkdown,
  normalizeHandoffModelSelection,
  resolveHandoffCwd,
} from "./wsHandoffJobs.shared";
import {
  generateClaudeHandoff,
  generateCodexHandoff,
  type HandoffJobDeps,
} from "./wsHandoffJobs.cli";

export interface ServerHandoffJobsShape {
  readonly startJob: (
    input: ServerStartHandoffJobInput,
  ) => Effect.Effect<ServerHandoffJob, ServerHandoffJobError>;
  readonly getJob: (jobId: string) => Effect.Effect<ServerHandoffJob, ServerHandoffJobError>;
}

export const makeServerHandoffJobs = Effect.gen(function* () {
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);
  const deps: HandoffJobDeps = {
    commandSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    fileSystem: yield* FileSystem.FileSystem,
    projectionSnapshotQuery: yield* ProjectionSnapshotQuery,
    serverSettings: yield* ServerSettingsService,
  };
  const jobs = new Map<string, ServerHandoffJob>();
  const runningJobsByThreadId = new Map<string, string>();

  const setJob = (job: ServerHandoffJob): ServerHandoffJob => {
    jobs.set(job.jobId, job);
    return job;
  };

  const processJob = (jobId: string) =>
    Effect.gen(function* () {
      const existing = jobs.get(jobId);
      if (!existing) {
        return;
      }
      const settings = yield* deps.serverSettings.getSettings;
      const snapshot = yield* deps.projectionSnapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === existing.threadId);
      if (!thread) {
        return yield* new ServerHandoffJobError({ message: "Source thread was not found." });
      }

      setJob({ ...existing, status: "running", updatedAt: new Date().toISOString() });

      const cwd = resolveHandoffCwd({
        thread,
        projects: snapshot.projects.map((project) => ({
          id: project.id,
          workspaceRoot: project.workspaceRoot,
        })),
        defaultChatCwd: resolveDefaultChatCwd(settings),
      });
      const sourceMarkdown = buildThreadSnapshotMarkdown(thread);
      const chunks = chunkMarkdown(sourceMarkdown);
      const generationModel = normalizeHandoffModelSelection(settings.textGenerationModelSelection);
      const generateMarkdown = (context: string, mode: "chunk" | "final") =>
        generationModel.provider === "claudeAgent"
          ? generateClaudeHandoff(deps, {
              cwd,
              prompt: buildHandoffPrompt({
                context,
                ...(existing.focus ? { focus: existing.focus } : {}),
                mode,
              }),
              modelSelection: generationModel,
            })
          : generateCodexHandoff(deps, {
              cwd,
              prompt: buildHandoffPrompt({
                context,
                ...(existing.focus ? { focus: existing.focus } : {}),
                mode,
              }),
              modelSelection: generationModel,
            });

      const partials = yield* Effect.forEach(
        chunks,
        (chunk, index) =>
          generateMarkdown(chunk, chunks.length > 1 ? "chunk" : "final").pipe(
            Effect.map((markdown) => `## Slice ${index + 1}\n\n${markdown}`),
          ),
        { concurrency: 1 },
      );
      const finalMarkdown =
        chunks.length === 1
          ? partials[0]!.replace(/^## Slice 1\s+/u, "").trim()
          : yield* generateMarkdown(partials.join("\n\n"), "final");
      const outputPath = yield* Effect.tryPromise({
        try: () => writeHandoffDocumentFile({ title: thread.title, content: finalMarkdown }),
        catch: (cause) =>
          new ServerHandoffJobError({
            message: "Failed to write handoff document.",
            cause,
          }),
      });

      setJob({
        ...jobs.get(jobId)!,
        status: "succeeded",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        outputPath,
        error: null,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const failed = jobs.get(jobId);
          if (!failed) {
            return;
          }
          setJob({
            ...failed,
            status: "failed",
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            error: Cause.pretty(cause),
          });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          const finished = jobs.get(jobId);
          if (finished) {
            runningJobsByThreadId.delete(finished.threadId);
          }
        }),
      ),
    );

  return {
    startJob: (input) =>
      Effect.gen(function* () {
        const runningJobId = runningJobsByThreadId.get(input.threadId);
        if (runningJobId) {
          const runningJob = jobs.get(runningJobId);
          if (runningJob && (runningJob.status === "queued" || runningJob.status === "running")) {
            return runningJob;
          }
        }

        const snapshot = yield* deps.projectionSnapshotQuery.getSnapshot();
        const thread = snapshot.threads.find((entry) => entry.id === input.threadId);
        if (!thread) {
          return yield* new ServerHandoffJobError({ message: "Source thread was not found." });
        }

        const createdAt = new Date().toISOString();
        const job = setJob({
          jobId: `handoff:${crypto.randomUUID()}`,
          threadId: input.threadId,
          status: "queued",
          title: thread.title,
          ...(input.focus ? { focus: input.focus } : {}),
          createdAt,
          updatedAt: createdAt,
          completedAt: null,
          outputPath: null,
          error: null,
        });
        runningJobsByThreadId.set(thread.id, job.jobId);
        void runPromise(processJob(job.jobId));
        return job;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerHandoffJobError({
              message: "Failed to prepare handoff job.",
              cause,
            }),
        ),
      ),
    getJob: (jobId) =>
      Effect.sync(() => jobs.get(jobId)).pipe(
        Effect.flatMap((job) =>
          job
            ? Effect.succeed(job)
            : Effect.fail(new ServerHandoffJobError({ message: "Handoff job was not found." })),
        ),
      ),
  } satisfies ServerHandoffJobsShape;
});
