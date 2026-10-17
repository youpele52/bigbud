import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { RemoteAgentWorkspaceClient } from "../../../remote-agent/remoteAgentWorkspaceClient.ts";
import {
  getConfiguredRemoteAgentComposition,
  isRemoteAgentExecutionTarget,
} from "../../../remote-agent/remoteAgentDefault.ts";
import type { V2CodingFileAction, V2CodingFileResult, V2CodingTarget } from "./Coding.files.ts";
import { acquireV2RemoteHandle } from "./Remote.handles.ts";

export type V2WorkspaceClientResolver = (target: string) => Promise<RemoteAgentWorkspaceClient>;
export const resolveV2RemoteWorkspaceClient: V2WorkspaceClientResolver = async (target) => {
  if (!isRemoteAgentExecutionTarget(target))
    throw new Error(
      "V2 bounded remote files require the existing agent transport, not raw SSH shell.",
    );
  const composition = getConfiguredRemoteAgentComposition();
  if (!composition) throw new Error("V2 remote workspace agent is unavailable.");
  return composition.pool.getWorkspaceClient(target);
};

/** Bound existing remote-agent root and epoch; never reconnect a mutation onto a replacement generation. */
export class V2RemoteFiles implements V2CodingTarget {
  private revoked = false;
  private constructor(
    readonly executionTargetId: string,
    readonly root: string,
    private readonly client: RemoteAgentWorkspaceClient,
    private readonly resolve: V2WorkspaceClientResolver,
    private readonly handle: string,
  ) {}
  static async open(
    target: string,
    root: string,
    owner: string,
    resolve = resolveV2RemoteWorkspaceClient,
  ) {
    if (!path.posix.isAbsolute(root) || root.includes("\\") || root.includes("\0"))
      throw new Error("V2 remote workspace requires an absolute POSIX root.");
    const client = await resolve(target);
    const handle = `bbv2_${createHash("sha256")
      .update(JSON.stringify([target, root, owner]))
      .digest("hex")}`;
    await acquireV2RemoteHandle(client, handle, root);
    return new V2RemoteFiles(target, root, client, resolve, handle);
  }
  /** Local revocation only. The agent owns retained root descriptors until this connection ends; v1 exposes no close RPC. */
  close() {
    this.revoked = true;
  }
  async releaseRemoteHandle(): Promise<never> {
    this.close();
    throw new Error(
      "V2 remote workspace handle release is unsupported by agent v1 (no workspace-close RPC). Local ownership is revoked; remote root remains connection-owned.",
    );
  }
  private async current() {
    if (
      this.revoked ||
      (await this.resolve(this.executionTargetId)).connection !== this.client.connection
    )
      throw new Error("V2 remote workspace generation lost; no automatic rebind.");
    if (this.revoked) throw new Error("V2 remote workspace revoked.");
  }
  private relative(filename: string, mutation = false) {
    const relative = path.posix.isAbsolute(filename)
      ? path.posix.relative(this.root, filename)
      : filename;
    if (
      relative !== "." &&
      (!relative ||
        relative.includes("\\") ||
        relative.includes("\0") ||
        relative.split("/").some((part) => !part || part === "." || part === ".."))
    )
      throw new Error("V2 remote path escapes the bound workspace.");
    if (
      relative
        .split("/")
        .some(
          (part) =>
            part === ".git" ||
            part === ".bigbud" ||
            (mutation && (part === ".opencode" || part === ".agents")),
        )
    )
      throw new Error("V2 remote protected metadata access rejected.");
    return relative;
  }
  private request(action: string, relative: string, payload?: unknown) {
    return {
      workspaceHandle: this.handle,
      path: relative === "." ? "" : relative,
      operationId: randomUUID(),
      requestDigest: createHash("sha256")
        .update(JSON.stringify([action, this.executionTargetId, this.root, relative, payload]))
        .digest(),
    };
  }
  async readBytes(filename: string, maximum: number, beforeRequest?: () => Promise<() => void>) {
    const relative = this.relative(filename);
    await this.current();
    const validate = await beforeRequest?.();
    validate?.();
    // A pinned reader deliberately has no reconnect callback: even reads may not rebind this owner.
    const result = await new RemoteAgentWorkspaceClient(this.client.connection).readFile({
      ...this.request("read", relative),
      maxBytes: maximum,
    });
    if (
      result.truncated ||
      result.totalBytes !== result.bytes.byteLength ||
      result.totalBytes > maximum
    )
      throw new Error(
        "V2 remote attachment/file byte bound exceeded or agent read is incomplete. Agent v1 bounded reads do not expose a stable multi-chunk snapshot; no unsafe concatenation fallback.",
      );
    return Buffer.from(result.bytes);
  }
  async run(
    action: V2CodingFileAction,
    beforeSpawn?: () => Promise<() => void>,
  ): Promise<V2CodingFileResult> {
    const mutation = action.action === "write" || action.action === "edit";
    const relative = this.relative(action.path, mutation);
    await this.current();
    const validate = await beforeSpawn?.();
    validate?.();
    if (this.revoked) throw new Error("V2 remote workspace revoked.");
    if (action.action === "list" || (action.action === "probe" && relative === ".")) {
      const entries = await new RemoteAgentWorkspaceClient(this.client.connection).listDirectory(
        this.request("list", relative),
      );
      if (entries.length > 1000) throw new Error("V2 remote directory exceeds bound.");
      return { entries: entries.map((entry) => entry.path) };
    }
    if (mutation) {
      // The existing agent protocol has CAS for existing files but no absent-file precondition.
      // Never pretend an empty expected hash gives exclusive-create semantics.
      if (!action.expectedSha256 || action.content === undefined)
        throw new Error(
          "V2 remote new-file creation requires a verified absent-file CAS contract; existing-file writes/edits are supported.",
        );
      const bytes = Buffer.from(action.content);
      if (bytes.byteLength > 131072) throw new Error("V2 remote write exceeds bound.");
      await this.client.writeFile(
        {
          ...this.request(action.action, relative, [
            action.expectedSha256,
            createHash("sha256").update(bytes).digest("hex"),
          ]),
          bytes,
          expectedSha256: action.expectedSha256,
        },
        beforeSpawn,
      );
      return {
        content: "Remote file updated",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }
    if (action.action === "check")
      throw new Error(
        "V2 remote syntax execution is not exposed; use bounded read/list/write/edit/skill.",
      );
    const bytes = await this.readBytes(relative, 131072, beforeSpawn);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return action.action === "probe"
      ? { content: "Remote target validated" }
      : { content, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
}
