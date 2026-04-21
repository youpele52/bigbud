import { ServiceMap } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk";

export interface OpencodeServerHandle {
  /** The connected client ready to use. */
  readonly client: OpencodeClient;
  /** The URL the server is listening on. */
  readonly url: string;
  /** Release this handle. When the last handle is released, the server stops. */
  release(): void;
}

export interface OpencodeServerManagerShape {
  /**
   * Acquire a handle to the shared OpenCode server.
   * Starts the server the first time; subsequent calls reuse the same process.
   * Call `handle.release()` when you no longer need it.
   */
  acquire(): Promise<OpencodeServerHandle>;
}

export class OpencodeServerManager extends ServiceMap.Service<
  OpencodeServerManager,
  OpencodeServerManagerShape
>()("t3/provider/Services/OpencodeServerManager") {}
