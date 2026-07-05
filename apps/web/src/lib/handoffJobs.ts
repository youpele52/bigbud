import type { ModelSelection, ThreadId } from "@bigbud/contracts";

import { HandoffError, buildHandoffSeedMessage } from "./handoff";
import { readNativeApi } from "../rpc/nativeApi";

const HANDOFF_JOB_POLL_INTERVAL_MS = 750;

export async function waitForHandoffJob(
  jobId: string,
  timeoutMs: number | null = null,
): Promise<{ outputPath: string; title: string }> {
  const api = readNativeApi();
  if (!api) {
    throw new HandoffError("Native API is not available.");
  }

  const startedAt = Date.now();
  for (;;) {
    const job = await api.server.getHandoffJob({ jobId });
    if (job.status === "succeeded") {
      if (!job.outputPath) {
        throw new HandoffError("Handoff finished without a document path.");
      }
      return { outputPath: job.outputPath, title: job.title };
    }
    if (job.status === "failed") {
      throw new HandoffError(job.error ?? "Handoff generation failed.");
    }
    if (timeoutMs !== null && Date.now() - startedAt >= timeoutMs) {
      throw new HandoffError("Handoff generation timed out.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, HANDOFF_JOB_POLL_INTERVAL_MS));
  }
}

export async function startHandoffJob(input: {
  threadId: ThreadId;
  focus?: string;
}): Promise<{ jobId: string; title: string }> {
  const api = readNativeApi();
  if (!api) {
    throw new HandoffError("Native API is not available.");
  }
  const job = await api.server.startHandoffJob(input);
  return { jobId: job.jobId, title: job.title };
}

export async function createHandoffSeedMessage(input: {
  readonly threadId: ThreadId;
  readonly focus?: string;
}): Promise<ReturnType<typeof buildHandoffSeedMessage>> {
  const started = await startHandoffJob(input);
  const completed = await waitForHandoffJob(started.jobId);
  return buildHandoffSeedMessage(completed.outputPath);
}

export interface HandoffBranchInput {
  readonly sourceThreadId: ThreadId;
  readonly nextModelSelection: ModelSelection;
  readonly focus?: string;
  readonly branchThread: (
    sourceThreadId: ThreadId,
    options?: {
      modelSelection?: ModelSelection;
      navigateToBranch?: boolean;
      seedMessages?: ReadonlyArray<ReturnType<typeof buildHandoffSeedMessage>>;
    },
  ) => Promise<ThreadId | null>;
}

export async function branchThreadWithHandoffJob(
  input: HandoffBranchInput,
): Promise<ThreadId | null> {
  const handoffSeedMessage = await createHandoffSeedMessage({
    threadId: input.sourceThreadId,
    ...(input.focus ? { focus: input.focus } : {}),
  });
  return input.branchThread(input.sourceThreadId, {
    modelSelection: input.nextModelSelection,
    navigateToBranch: true,
    seedMessages: [handoffSeedMessage],
  });
}
