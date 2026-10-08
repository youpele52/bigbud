import path from "node:path";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { ModelRef, SessionInfo } from "@opencode/client";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { v2Request } from "./Client.ts";
import type { OpencodeV2ServerManager, V2ProcessLease } from "./ServerManager.ts";
import type { V2ProcessConfig } from "./ServerManager.child.ts";

interface DevelopmentSession {
  readonly threadId: ThreadId;
  readonly native: SessionInfo;
  readonly epoch: number;
  readonly lease: V2ProcessLease;
  readonly unregister: () => void;
}

/** Isolated synthetic session harness, not a released or model-executing adapter. */
export class OpencodeV2DevelopmentSessions {
  private readonly sessions = new Map<ThreadId, DevelopmentSession>();
  private readonly starting = new Set<ThreadId>();
  private closed = false;

  constructor(private readonly manager: OpencodeV2ServerManager) {}

  async start(input: {
    readonly threadId: ThreadId;
    readonly config: V2ProcessConfig;
    readonly directory: string;
    readonly model: ModelRef;
    readonly epoch: number;
    readonly onDirty: () => void;
  }): Promise<DevelopmentSession> {
    if (
      this.closed ||
      this.sessions.has(input.threadId) ||
      this.starting.has(input.threadId) ||
      input.config.runtimeTargetId !== "local" ||
      !Number.isInteger(input.epoch) ||
      input.epoch < 0 ||
      !input.model.providerID ||
      !input.model.id ||
      input.model.id === "default"
    ) {
      throw new Error("OpenCode v2 development session input or ownership rejected.");
    }
    const root = await realpath(input.config.profileRoot);
    const directory = await realpath(input.directory);
    const relative = path.relative(root, directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(
        "OpenCode v2 development sessions require a synthetic workspace inside the isolated profile.",
      );
    }
    // Fence before any asynchronous native session creation.
    if (this.starting.has(input.threadId))
      throw new Error("OpenCode v2 concurrent session start rejected.");
    this.starting.add(input.threadId);
    let lease: V2ProcessLease | undefined;
    try {
      lease = await this.manager.acquire(input.config);
      const nativeSessionId = `ses_bigbud_${createHash("sha256")
        .update(JSON.stringify([root, input.threadId]))
        .digest("hex")}`;
      const native = await v2Request("session.create", (signal) =>
        lease!.process.client.session.create(
          {
            id: nativeSessionId,
            location: { directory },
            model: input.model,
            metadata: { bigbud_provider: "opencodeV2", bigbud_thread: input.threadId },
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
          },
          { signal },
        ),
      );
      if (
        this.closed ||
        !lease.process.isRunning() ||
        native.id !== nativeSessionId ||
        native.location.directory !== directory
      ) {
        throw new Error("OpenCode v2 stale or mismatched session response.");
      }
      const unregister = lease.hub.register({
        nativeSessionId,
        location: directory,
        onEvent: async () => {},
        onDirty: input.onDirty,
      });
      const session = { threadId: input.threadId, native, epoch: input.epoch, lease, unregister };
      this.sessions.set(input.threadId, session);
      return session;
    } catch {
      await lease?.release();
      // Creation uncertainty never falls back to a fresh native ID or another provider.
      throw new Error("OpenCode v2 development session creation failed or is unconfirmed.");
    } finally {
      this.starting.delete(input.threadId);
    }
  }

  list(): ReadonlyArray<DevelopmentSession> {
    return [...this.sessions.values()];
  }

  async stop(threadId: ThreadId): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    session.unregister();
    await session.lease.release();
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((threadId) => this.stop(threadId)));
    await this.manager.close();
  }
}
