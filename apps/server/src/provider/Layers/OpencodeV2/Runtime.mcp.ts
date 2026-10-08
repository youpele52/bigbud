import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import type { OwnedV2Process } from "./ServerManager.child.ts";

const BridgeConfig = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Schema.String,
  disabled: Schema.optional(Schema.Boolean),
});

/** Process-global native MCP is confined to a dedicated isolated owner, never shared by thread. */
export class V2IsolatedMcp {
  private readonly servers = new WeakMap<OwnedV2Process, Map<string, string>>();
  constructor(
    private readonly runtime: OpencodeV2Runtime,
    private readonly timeoutMs = 10000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      throw new Error("V2 MCP deadline bound rejected.");
  }

  private owner(threadId: ThreadId, readOnly = false): V2RuntimeSession {
    const session = this.runtime.get(threadId);
    if (!readOnly) this.runtime.mutations.assertSafe();
    if (session.row && session.row.state !== "terminal")
      throw new Error("V2 MCP changes cannot race active/unconfirmed admission.");
    session.lease.claimExclusive();
    return session;
  }

  private async verified(session: V2RuntimeSession, server: string, enabled?: boolean) {
    if (session.stopped || !session.lease.process.isRunning()) return false;
    const result = await v2Request(
      "mcp.verify",
      (signal) =>
        session.lease.process.client.mcp.list(
          { location: { directory: session.native.location.directory } },
          { signal },
        ),
      { timeoutMs: this.timeoutMs },
    );
    if (result.location.directory !== session.native.location.directory || result.data.length > 64)
      return false;
    const matches = result.data.filter((item) => item.name === server);
    return enabled === undefined
      ? matches.length === 0
      : matches.length === 1 && matches[0]!.status.status === (enabled ? "connected" : "disabled");
  }

  private name(threadId: ThreadId, name: string) {
    if (!name.trim() || name.length > 128) throw new Error("V2 MCP name bound rejected.");
    return `bbv2_${createHash("sha256")
      .update(JSON.stringify([threadId, name]))
      .digest("hex")}`;
  }

  async replace(threadId: ThreadId, input: Readonly<Record<string, unknown>>) {
    return this.runtime.withSession(threadId, () => this.replaceOwned(threadId, input));
  }

  private async replaceOwned(threadId: ThreadId, input: Readonly<Record<string, unknown>>) {
    if (Object.keys(input).length > 32) throw new Error("V2 MCP server bound exceeded.");
    // Validate the complete proposal before the first native side effect.
    const proposal = Object.entries(input).map(([name, value]) => {
      const config = Schema.decodeUnknownSync(BridgeConfig)(value);
      const url = new URL(config.url);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("V2 isolated MCP requires a loopback synthetic bridge.");
      return {
        name: this.name(threadId, name),
        alias: name,
        url: url.href,
        disabled: config.disabled ?? true,
      };
    });
    const session = this.owner(threadId);
    const client = session.lease.process.client;
    const location = { directory: session.native.location.directory };
    const owned = this.servers.get(session.lease.process) ?? new Map<string, string>();
    if (new Set([...owned.keys(), ...proposal.map((server) => server.name)]).size > 64)
      throw new Error("V2 MCP retained namespace bound exceeded; remove existing servers first.");
    this.servers.set(session.lease.process, owned);
    // Record ownership before any uncertain mutation; cleanup/retry cannot lose the namespace.
    for (const server of proposal) {
      owned.set(server.name, server.alias);
      await this.runtime.mutations.run(
        session,
        "mcp.add",
        (signal) =>
          client.mcp.add(
            {
              server: server.name,
              location,
              config: {
                type: "remote",
                url: server.url,
                oauth: false,
                codemode: false,
                disabled: server.disabled,
              },
            },
            { signal },
          ),
        () => this.verified(session, server.name, !server.disabled),
        this.timeoutMs,
      );
    }
    for (const server of [...owned.keys()])
      if (!proposal.some((item) => item.name === server)) {
        await this.runtime.mutations.run(
          session,
          "mcp.remove",
          (signal) => client.mcp.remove({ server, location }, { signal }),
          () => this.verified(session, server),
          this.timeoutMs,
        );
        owned.delete(server);
      }
  }

  async refresh(threadId: ThreadId) {
    return this.runtime.withSession(threadId, () => this.refreshOwned(threadId));
  }

  private async refreshOwned(threadId: ThreadId) {
    const session = this.owner(threadId, true);
    this.runtime.mutations.retryVerification();
    const result = await v2Request("mcp.list", (signal) =>
      session.lease.process.client.mcp.list(
        { location: { directory: session.native.location.directory } },
        { signal },
      ),
    );
    if (result.location.directory !== session.native.location.directory || result.data.length > 64)
      throw new Error("V2 MCP catalog ownership/bound rejected.");
    const owned = this.servers.get(session.lease.process) ?? new Map<string, string>();
    return result.data
      .filter((server) => owned.has(server.name))
      .map((server) => ({
        name: owned.get(server.name)!,
        status:
          server.status.status === "needs_auth" ? ("needs-auth" as const) : server.status.status,
      }));
  }

  async connect(threadId: ThreadId, name: string, enabled: boolean) {
    return this.runtime.withSession(threadId, () => this.connectOwned(threadId, name, enabled));
  }

  private async connectOwned(threadId: ThreadId, name: string, enabled: boolean) {
    const session = this.owner(threadId);
    const server = this.name(threadId, name);
    if (!this.servers.get(session.lease.process)?.has(server))
      throw new Error("V2 MCP operation does not own that server.");
    const input = { server, location: { directory: session.native.location.directory } };
    await this.runtime.mutations.run(
      session,
      enabled ? "mcp.connect" : "mcp.disconnect",
      (signal) =>
        enabled
          ? session.lease.process.client.mcp.connect(input, { signal })
          : session.lease.process.client.mcp.disconnect(input, { signal }),
      () => this.verified(session, server, enabled),
      this.timeoutMs,
    );
  }
}
