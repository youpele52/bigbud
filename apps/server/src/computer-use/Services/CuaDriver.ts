import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export interface CuaDriverCallResult {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string | undefined;
    readonly mimeType?: string | undefined;
    readonly data?: string | undefined;
  }>;
  readonly structuredContent?: unknown;
}

export class CuaDriverError extends Data.TaggedError("CuaDriverError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CuaDriverShape {
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<CuaDriverCallResult, CuaDriverError>;
  readonly runDoctor: () => Effect.Effect<string, CuaDriverError>;
  readonly dispose: Effect.Effect<void, never>;
}

export class CuaDriver extends ServiceMap.Service<CuaDriver, CuaDriverShape>()(
  "t3/computer-use/Services/CuaDriver",
) {}
