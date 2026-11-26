import { randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import {
  REMOTE_AGENT_PTY_LIMIT_REACHED,
  type RemoteAgentPtyCreateLifecycleFields,
} from "./remoteAgentProtocol.ptyLifecycle.ts";
import { RemoteAgentPtyError, RemoteAgentPtyLimitError } from "./remoteAgentPtyClient.types.ts";

export class RemoteAgentPtyClient {
  constructor(
    readonly connection: RemoteAgentConnection,
    private readonly reconnect?: () => Promise<RemoteAgentConnection>,
  ) {}

  async create(input: {
    readonly ptyId?: string;
    readonly requestDigest?: Uint8Array;
    readonly workspaceHandle: string;
    readonly cwd: string;
    readonly shell: string;
    readonly args?: ReadonlyArray<string>;
    readonly cols: number;
    readonly rows: number;
    readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    readonly profileLaunch?: boolean;
    /** Protocol 1.9 fields; callers send only what the host advertises. */
    readonly lifecycle?: RemoteAgentPtyCreateLifecycleFields;
    /** Protocol 1.10 X2 inventory identity; absent on a legacy create. */
    readonly paneIdentity?: {
      readonly threadId: string;
      readonly paneId: string;
      readonly kind: "local" | "managed-ssh";
    };
    readonly onRejected?: () => Promise<void>;
  }): Promise<RemoteAgentPtyProcess> {
    const ptyId = input.ptyId ?? randomUUID();
    const process = new RemoteAgentPtyProcess(this.connection, ptyId, this.reconnect);
    try {
      const response = await this.connection.request(
        {
          type: "ptyCreateRequest",
          value: {
            requestId: randomUUID(),
            ptyId,
            requestDigest: input.requestDigest ?? new Uint8Array(),
            workspaceHandle: input.workspaceHandle,
            cwd: input.cwd,
            shell: input.shell,
            args: input.args ?? [],
            cols: input.cols,
            rows: input.rows,
            ...(input.environment ? { environment: input.environment } : {}),
            ...(input.profileLaunch ? { profileLaunch: true } : {}),
            ...input.lifecycle,
            ...(input.paneIdentity
              ? {
                  threadId: input.paneIdentity.threadId,
                  paneId: input.paneIdentity.paneId,
                  paneKind: input.paneIdentity.kind,
                }
              : {}),
          },
        },
        (frame) => frame.type === "ptyCreateResponse" && frame.value.ptyId === ptyId,
      );
      if (response.type !== "ptyCreateResponse")
        throw new RemoteAgentPtyError("PTY_OUTCOME_UNKNOWN", "PTY creation outcome is unknown.");
      if (!response.value.accepted) {
        await input.onRejected?.();
        if (response.value.errorCode === REMOTE_AGENT_PTY_LIMIT_REACHED)
          throw new RemoteAgentPtyLimitError(response.value.errorMessage, response.value);
        throw new RemoteAgentPtyError(response.value.errorCode, response.value.errorMessage);
      }
      process.lifecycle.evictedPtyId = response.value.evictedPtyId || undefined;
      process.setPid(response.value.pid);
      process.setLaunchStatus(response.value.launchStatus);
      if (input.profileLaunch && process.launchStatus !== "unconfirmed")
        throw new RemoteAgentPtyError("PTY_OUTCOME_UNKNOWN", "Profile launch evidence is missing.");
      await process.attach(0);
      if (input.profileLaunch && process.launchStatus !== "unconfirmed")
        throw new RemoteAgentPtyError("PTY_OUTCOME_UNKNOWN", "Profile attach evidence is missing.");
      return process;
    } catch (cause) {
      // Detach listeners only. Unknown outcomes must not kill, retry, or release ownership.
      process.detach();
      throw cause;
    }
  }
}
