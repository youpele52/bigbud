import { Effect, Schema, ServiceMap } from "effect";

export interface ThreadShellRunInput {
  readonly threadId: string;
  readonly cwd: string;
  readonly command: string;
  readonly timeoutMs?: number | null;
  readonly onOutputChunk?: (chunk: string) => void;
}

export interface ThreadShellRunResult {
  readonly output: string;
  readonly exitCode: number | null;
}

export class ThreadShellRunnerError extends Schema.TaggedErrorClass<ThreadShellRunnerError>()(
  "ThreadShellRunnerError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ThreadShellRunnerShape {
  readonly run: (
    input: ThreadShellRunInput,
  ) => Effect.Effect<ThreadShellRunResult, ThreadShellRunnerError>;
  readonly closeThread: (threadId: string) => Effect.Effect<void>;
}

export class ThreadShellRunner extends ServiceMap.Service<
  ThreadShellRunner,
  ThreadShellRunnerShape
>()("t3/shell/Services/ThreadShellRunner") {}
