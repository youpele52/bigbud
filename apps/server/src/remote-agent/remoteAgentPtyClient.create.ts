import { randomUUID } from "node:crypto";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyError, RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";

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
    readonly onRejected?: () => Promise<void>;
  }): Promise<RemoteAgentPtyProcess> {
    const ptyId = input.ptyId ?? randomUUID();
    const process = new RemoteAgentPtyProcess(this.connection, ptyId, this.reconnect);
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
        },
      },
      (frame) => frame.type === "ptyCreateResponse" && frame.value.ptyId === ptyId,
    );
    if (response.type !== "ptyCreateResponse")
      throw new RemoteAgentPtyError("PTY_OUTCOME_UNKNOWN", "PTY creation outcome is unknown.");
    if (!response.value.accepted) {
      await input.onRejected?.();
      throw new RemoteAgentPtyError(response.value.errorCode, response.value.errorMessage);
    }
    process.setPid(response.value.pid);
    await process.attach(0);
    return process;
  }
}
