import { readFile } from "node:fs/promises";

import { RUNTIME_MODES } from "@bigbud/contracts/constants/runtime.constant.ts";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import {
  PeerAction,
  PeerGrantId,
  PeerPermissionCeiling,
  type PeerGrant,
} from "@bigbud/contracts/server/remotePeer.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

import {
  defaultAuthorizedKeysFile,
  grantPeer,
  listPeerGrants,
  resolvePeerHelperPaths,
  revokePeer,
  type PeerGrantReply,
} from "./cli.peer.client.ts";

const authority = () =>
  Flag.string("authority").pipe(
    Flag.withSchema(RemoteBackendAuthorityId),
    Flag.withDescription("This worker account's backend authority id (32 lowercase hex)."),
  );
const json = () => Flag.boolean("json").pipe(Flag.withDescription("Print the reply as JSON."));
const authorizedKeys = () =>
  Flag.string("authorized-keys").pipe(
    Flag.optional,
    Flag.withDescription("authorized_keys file to edit (default ~/.ssh/authorized_keys)."),
  );
const describe = (grant: PeerGrant) =>
  `${grant.grantId} coordinator=${grant.coordinatorAuthorityId} key=${grant.coordinatorKeyFingerprint} ` +
  `actions=${grant.actions.join(",")} mode=${grant.ceiling.runtimeMode} ` +
  `providers=${grant.ceiling.providers.join(",")} workspaces=${grant.ceiling.workspaceRoots.join(",")} ` +
  `expires=${grant.expiresAt}${grant.revokedAt ? ` revoked=${grant.revokedAt}` : ""}`;

const report = (asJson: boolean, reply: PeerGrantReply, extra: Record<string, unknown> = {}) =>
  Effect.sync(() => {
    if (asJson) process.stdout.write(`${JSON.stringify({ ...reply, ...extra })}\n`);
    else if (reply.ok)
      process.stdout.write(
        reply.value.grants.length === 0
          ? "No peer grants.\n"
          : `${reply.value.grants.map(describe).join("\n")}\n`,
      );
    else process.stderr.write(`bigbud peer: refused (${reply.refused}).\n`);
    if (!reply.ok) process.exitCode = 1;
  });
const failed = (error: unknown) =>
  Effect.sync(() => {
    process.stderr.write(
      `bigbud peer: ${error instanceof Error ? error.message : "operation failed"}\n`,
    );
    process.exitCode = 1;
  });

const grant = Command.make("grant", {
  authorityId: authority(),
  coordinator: Flag.string("coordinator").pipe(
    Flag.withSchema(RemoteBackendAuthorityId),
    Flag.withDescription("The coordinator backend's authority id."),
  ),
  publicKey: Flag.string("public-key").pipe(
    Flag.withDescription("Path to the coordinator's dedicated ssh-ed25519 public key file."),
  ),
  workspace: Flag.string("workspace").pipe(
    Flag.atLeast(1),
    Flag.withDescription("Absolute workspace root the coordinator may use (repeatable)."),
  ),
  provider: Flag.string("provider").pipe(
    Flag.atLeast(1),
    Flag.withDescription("Provider the coordinator may use (repeatable)."),
  ),
  runtimeMode: Flag.choice("runtime-mode", RUNTIME_MODES).pipe(
    Flag.withDefault("approval-required"),
  ),
  action: Flag.choice("action", PeerAction.literals).pipe(
    Flag.atLeast(0),
    Flag.withDescription("Allowed peer action (repeatable; default all four)."),
  ),
  expiresDays: Flag.integer("expires-days").pipe(Flag.withDefault(30)),
  authorizedKeys: authorizedKeys(),
  node: Flag.string("node").pipe(Flag.optional),
  helper: Flag.string("helper").pipe(Flag.optional),
  json: json(),
}).pipe(
  Command.withDescription(
    "Issue a peer grant to a coordinator and authorize its key with a forced command limited to the peer socket.",
  ),
  Command.withHandler((input) =>
    Effect.tryPromise(async () => {
      if (input.expiresDays < 1 || input.expiresDays > 365)
        throw new Error("--expires-days must be between 1 and 365.");
      const ceiling = Schema.decodeUnknownSync(PeerPermissionCeiling)({
        runtimeMode: input.runtimeMode,
        providers: [...new Set(input.provider)],
        workspaceRoots: [...new Set(input.workspace)],
      });
      const paths = await resolvePeerHelperPaths({
        nodeBinary: Option.getOrUndefined(input.node),
        helperEntry: Option.getOrUndefined(input.helper),
      });
      return grantPeer({
        authorityId: input.authorityId,
        coordinatorAuthorityId: input.coordinator,
        publicKey: await readFile(input.publicKey, "utf8"),
        actions:
          input.action.length === 0
            ? ["delegate", "status", "follow", "cancel"]
            : [...new Set(input.action)],
        ceiling,
        expiresAt: new Date(Date.now() + input.expiresDays * 86_400_000).toISOString(),
        ...paths,
        authorizedKeysFile: Option.getOrElse(input.authorizedKeys, defaultAuthorizedKeysFile),
      });
    }).pipe(
      Effect.flatMap((reply) => report(input.json, reply)),
      Effect.catch(failed),
    ),
  ),
);

const revoke = Command.make("revoke", {
  authorityId: authority(),
  grantId: Flag.string("grant").pipe(Flag.withSchema(PeerGrantId)),
  authorizedKeys: authorizedKeys(),
  json: json(),
}).pipe(
  Command.withDescription("Remove a grant's authorized key line and revoke the grant."),
  Command.withHandler((input) =>
    Effect.tryPromise(() =>
      revokePeer({
        authorityId: input.authorityId,
        grantId: input.grantId,
        authorizedKeysFile: Option.getOrElse(input.authorizedKeys, defaultAuthorizedKeysFile),
      }),
    ).pipe(
      Effect.flatMap(({ keyRemoval, ...reply }) =>
        report(input.json, reply, { keyRemoval }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!input.json) process.stdout.write(`authorized_keys: ${keyRemoval}\n`);
              if (keyRemoval === "failed") process.exitCode = 1;
            }),
          ),
        ),
      ),
      Effect.catch(failed),
    ),
  ),
);

const list = Command.make("list", { authorityId: authority(), json: json() }).pipe(
  Command.withDescription("List this worker's peer grants, including revoked ones."),
  Command.withHandler((input) =>
    Effect.tryPromise(() => listPeerGrants(input.authorityId)).pipe(
      Effect.flatMap((reply) => report(input.json, reply)),
      Effect.catch(failed),
    ),
  ),
);

export const peerCommand = Command.make("peer").pipe(
  Command.withDescription("Manage peer grants that let a coordinator backend delegate work here."),
  Command.withSubcommands([grant, revoke, list]),
);
