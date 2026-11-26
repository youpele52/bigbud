import { randomBytes } from "node:crypto";
import {
  ServerUnlockSshKeyError,
  ServerUnlockSshPasswordError,
  type ServerUnlockSshKeyInput,
  type ServerUnlockSshPasswordInput,
  type ServerUnlockSshPasswordResult,
  ServerVerifyExecutionTargetError,
  type ServerVerifyExecutionTargetInput,
  type ServerVerifyExecutionTargetResult,
} from "@bigbud/contracts/server/server";
import {
  ServerRemoteConnectionError,
  type ServerRemoteConnectionInput,
  type ServerRemoteConnectionResult,
} from "@bigbud/contracts/server/server.remoteConnection";
import {
  type ServerListRemoteFoldersInput,
  type ServerListRemoteFoldersResult,
} from "@bigbud/contracts/server/server.remoteFolders";
import {
  ServerTrustSshHostError,
  type ServerTrustSshHostInput,
  type ServerTrustSshHostResult,
  type SshHostTrustChallenge,
} from "@bigbud/contracts/server/server.sshHostTrust";

import {
  SshOwnerDevPickerError,
  invalidChallenge,
  folderLookupFailure,
  ownerFailure,
  startupFailure,
} from "./sshOwnerDevPicker.errors.ts";
import type { PickerProofOwner } from "./sshOwnerPickerProof.client.session.ts";
import type { PickerProofAliasList } from "./sshOwnerPickerProof.codec.aliases.ts";
import type { PickerProofTrust } from "./sshOwnerPickerProof.codec.outcome.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  buildSshHostTrustRequiredMessage,
  SshTargetAuthRequiredError,
} from "./sshTargetUnavailable.ts";
import { RemoteTargetDisconnectedError } from "./sshTargetDisconnects.ts";
import { waitForOwner, wire } from "./sshOwnerDevPicker.async.ts";
import {
  makeAliasDescriptorGuard,
  type SshOwnerDevAliasBinding,
} from "./sshOwnerDevPicker.aliasBinding.ts";

type DevPickerOwner = Pick<
  PickerProofOwner,
  | "listRemoteFolders"
  | "listAliases"
  | "inspectTrust"
  | "approveTrust"
  | "connect"
  | "disconnect"
  | "close"
> & { readonly aliasDescriptor?: Uint8Array | undefined };

export interface SshOwnerDevPickerOptions<Owner extends DevPickerOwner = DevPickerOwner> {
  readonly executionTargetId: ServerRemoteConnectionInput["executionTargetId"];
  /** Trusted fixture label for the confirmation UI, not a caller operand. */
  readonly host: string;
  readonly expectedFingerprint?: string;
  readonly allowJumpFirstUse?: boolean;
  /** Must start the private client for exactly this fixture target, with its dedicated dev store. */
  readonly startOwner: (profileBinding: Uint8Array) => Promise<Owner>;
  /** Refuse picker reads and approvals if the selected disposable config changed. */
  readonly checkAliasSource?: () => Promise<void>;
  /** Saved-alias retargeting rule for a user-authored alias; scoped to this profile. */
  readonly aliasBinding?: SshOwnerDevAliasBinding;
  /** Trusted disposable Linux selection only. The callback cannot receive a password. */
  readonly unlockSyntheticPasswordFixture?: (client: Owner) => Promise<void>;
  /** Select only for a trusted fixture whose owner has a private cancellation channel. */
  readonly listWithCancellation?: (
    client: Owner,
    input: ServerListRemoteFoldersInput,
    signal: AbortSignal,
  ) => Promise<ServerListRemoteFoldersResult>;
}

type DevPickerTrust =
  | Extract<PickerProofTrust, { state: "verified" }>
  | { readonly state: "approvalRequired"; readonly challenge: SshHostTrustChallenge };

/** Public fixture intent marker, not the password consumed by native OpenSSH. */
export const SYNTHETIC_SSH_UNLOCK_INTENT = "bigbud-disposable-owner-unlock";

const MAX_PENDING_OPERATIONS = 8;

/** One adapter per opted-in dev profile. No attachment, respawn, credential inputs or SSH fallback. */
export function makeSshOwnerDevPicker<Owner extends DevPickerOwner>({
  executionTargetId,
  host,
  expectedFingerprint,
  allowJumpFirstUse = false,
  startOwner,
  checkAliasSource,
  aliasBinding,
  listWithCancellation,
  unlockSyntheticPasswordFixture,
}: SshOwnerDevPickerOptions<Owner>) {
  const profileBinding = randomBytes(32);
  let owner: Promise<Owner> | undefined;
  let closing: Promise<void> | undefined;
  let queue = Promise.resolve();
  let pending = 0;
  let challenge: { readonly id: string; readonly ownerToken: Uint8Array } | undefined;
  // Folder reads admitted before a Disconnect request. Disconnect fences them so a late
  // startup success cannot be delivered or let a queued read dial ahead of the transition.
  const pendingReads = new Set<AbortController>();
  const aliasGuard = makeAliasDescriptorGuard(aliasBinding);

  const unavailable = () =>
    new SshOwnerDevPickerError("closed", "The development SSH picker is closed.");
  const getOwner = () =>
    (owner ??= Promise.resolve()
      .then(() => startOwner(Uint8Array.from(profileBinding)))
      .catch((error: unknown) => {
        throw startupFailure(error);
      }));

  // The private client admits one operation at a time. Keep multi-step trust flows atomic with
  // respect to other picker requests, and stop admitting work as soon as close is requested.
  async function run<A>(
    input: ServerRemoteConnectionInput,
    operation: () => Promise<A>,
    signal?: AbortSignal,
  ): Promise<A> {
    if (input.executionTargetId !== executionTargetId) {
      throw new SshOwnerDevPickerError(
        "unsupportedTarget",
        "This development SSH picker only supports its configured fixture target.",
      );
    }
    signal?.throwIfAborted();
    if (closing) throw unavailable();
    if (pending >= MAX_PENDING_OPERATIONS) {
      throw new SshOwnerDevPickerError(
        "busy",
        "The development SSH picker is busy. Retry the operation.",
      );
    }
    pending++;
    const result = queue
      .then(() => {
        signal?.throwIfAborted();
        if (closing) throw unavailable();
        return operation();
      })
      .finally(() => {
        pending--;
      });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function useOwner<A>(
    operation: (client: Owner) => Promise<A>,
    signal?: AbortSignal,
    admitAlias = true,
  ): Promise<A> {
    signal?.throwIfAborted();
    const pending = getOwner();
    const client = signal ? await waitForOwner(pending, signal) : await pending;
    signal?.throwIfAborted();
    if (closing) throw unavailable();
    // Before any owner request that could dial. Connect/Disconnect never dial.
    if (admitAlias) await aliasGuard.admit(client);
    signal?.throwIfAborted();
    try {
      return await operation(client);
    } catch (error) {
      if (error instanceof SshTargetAuthRequiredError || error instanceof SshOwnerDevPickerError)
        throw error;
      if (error instanceof PickerProofOwnerError && error.code === "targetDisconnected") {
        challenge = undefined;
        throw new RemoteTargetDisconnectedError(executionTargetId);
      }
      if (
        error instanceof PickerProofOwnerError &&
        (error.code === "ownerUnavailable" ||
          error.code === "outcomeUnknown" ||
          error.code === "protocolError" ||
          error.code === "storageUnavailable")
      ) {
        challenge = undefined;
      }
      throw ownerFailure(error);
    }
  }

  async function inspect(client: DevPickerOwner, signal?: AbortSignal): Promise<DevPickerTrust> {
    challenge = undefined;
    if (checkAliasSource) await checkAliasSource();
    signal?.throwIfAborted();
    const result = await client.inspectTrust();
    signal?.throwIfAborted();
    if (
      expectedFingerprint &&
      (result.keyType !== "ssh-ed25519" || result.fingerprint !== expectedFingerprint)
    ) {
      throw new PickerProofOwnerError("hostKeyChanged");
    }
    if (result.state === "verified") return result;
    const challengeId = `rust-dev${result.jumpLeg ? "-jump" : ""}:${randomBytes(32).toString("base64url")}`;
    challenge = { id: challengeId, ownerToken: Uint8Array.from(result.challenge) };
    return {
      state: "approvalRequired",
      challenge: {
        challengeId,
        host: result.jumpLeg ? `SSH jump route hop ${result.jumpLeg}` : host,
        keyType: result.keyType,
        fingerprint: result.fingerprint,
      },
    };
  }

  async function list(client: Owner, input: ServerListRemoteFoldersInput, signal?: AbortSignal) {
    if (checkAliasSource) await checkAliasSource();
    signal?.throwIfAborted();
    try {
      if (listWithCancellation) {
        return await listWithCancellation(client, input, signal ?? new AbortController().signal);
      }
      return await client.listRemoteFolders(input);
    } catch (error) {
      if (
        !(error instanceof PickerProofOwnerError) ||
        error.code !== "trustRequired" ||
        (error.jumpFailure && !allowJumpFirstUse)
      )
        throw error;
      signal?.throwIfAborted();
      const trust = await inspect(client, signal);
      if (trust.state === "verified") throw error;
      throw new SshTargetAuthRequiredError(
        executionTargetId,
        "host-trust",
        buildSshHostTrustRequiredMessage(JSON.stringify(trust.challenge)),
      );
    }
  }

  function transition(
    input: ServerRemoteConnectionInput,
    action: "connect" | "disconnect",
  ): Promise<ServerRemoteConnectionResult> {
    if (action === "disconnect" && input.executionTargetId === executionTargetId) {
      for (const read of pendingReads)
        read.abort(new RemoteTargetDisconnectedError(executionTargetId));
    }
    return wire(ServerRemoteConnectionError, () =>
      run(input, () =>
        useOwner(
          async (client) => {
            challenge = undefined;
            const { state } = await client[action]();
            if (state !== (action === "connect" ? "connected" : "disconnected")) {
              throw new PickerProofOwnerError("protocolError");
            }
            if (action === "connect") await aliasGuard.reapproveOnConnect(client);
            return { executionTargetId, disconnected: state === "disconnected" };
          },
          undefined,
          false,
        ),
      ),
    );
  }

  return {
    withOwner: <A>(
      executionTargetId: string,
      operation: (client: Owner) => Promise<A>,
      signal?: AbortSignal,
    ) => run({ executionTargetId }, () => useOwner(operation, signal), signal),
    /** Read-only config discovery: never dials and never applies the saved-alias guard. */
    listAliases: (): Promise<PickerProofAliasList> =>
      run({ executionTargetId }, () =>
        useOwner((client) => client.listAliases(), undefined, false),
      ),
    inspectTrust: (input: ServerRemoteConnectionInput) => run(input, () => useOwner(inspect)),
    async listRemoteFolders(input: ServerListRemoteFoldersInput, signal?: AbortSignal) {
      const fence = new AbortController();
      pendingReads.add(fence);
      const linked = signal ? AbortSignal.any([signal, fence.signal]) : fence.signal;
      try {
        const result = await run(
          input,
          () => useOwner((client) => list(client, input, linked), linked),
          linked,
        );
        // A non-cancellable read can still finish after Disconnect was requested. Discard it.
        if (fence.signal.aborted) throw fence.signal.reason;
        return result;
      } catch (cause) {
        throw folderLookupFailure(fence.signal.aborted ? fence.signal.reason : cause);
      } finally {
        pendingReads.delete(fence);
      }
    },
    async unlockSshKey(_input: ServerUnlockSshKeyInput): Promise<never> {
      throw new ServerUnlockSshKeyError({
        message: "The selected development SSH owner does not accept key passphrases.",
      });
    },
    unlockSshPassword(input: ServerUnlockSshPasswordInput): Promise<ServerUnlockSshPasswordResult> {
      if (
        process.platform !== "linux" ||
        !unlockSyntheticPasswordFixture ||
        input.password !== SYNTHETIC_SSH_UNLOCK_INTENT
      ) {
        return Promise.reject(
          new ServerUnlockSshPasswordError({
            message: "The selected development SSH owner does not accept passwords.",
          }),
        );
      }
      // Queue only the authorized target and fixture capability, never input.password.
      const target = { executionTargetId: input.executionTargetId };
      return wire(ServerUnlockSshPasswordError, () =>
        run(target, () =>
          useOwner(async (client) => {
            await unlockSyntheticPasswordFixture(client);
            return { message: "Disposable SSH fixture unlocked." };
          }),
        ),
      );
    },
    trustSshHost: (input: ServerTrustSshHostInput): Promise<ServerTrustSshHostResult> =>
      wire(ServerTrustSshHostError, () =>
        run(input, async () => {
          // An exact target match (above) and a live, profile-local handle are both required.
          if (challenge?.id !== input.challengeId) throw invalidChallenge();
          const { ownerToken } = challenge;
          challenge = undefined;
          if (input.cancel) {
            if (!allowJumpFirstUse || !input.challengeId.startsWith("rust-dev-jump:"))
              throw invalidChallenge();
            return { message: "SSH host trust request canceled." };
          }
          if (checkAliasSource) await checkAliasSource();
          return useOwner(async (client) => {
            try {
              const trust = await client.approveTrust(ownerToken);
              if (trust.state !== "verified") throw new PickerProofOwnerError("protocolError");
              return { message: "SSH host trusted." };
            } catch (error) {
              if (error instanceof PickerProofOwnerError && error.code === "operationDenied")
                throw invalidChallenge();
              throw error;
            }
          });
        }),
      ),
    connectExecutionTarget: (input: ServerRemoteConnectionInput) => transition(input, "connect"),
    disconnectExecutionTarget: (input: ServerRemoteConnectionInput) =>
      transition(input, "disconnect"),
    verifyExecutionTarget: (
      input: ServerVerifyExecutionTargetInput,
    ): Promise<ServerVerifyExecutionTargetResult> =>
      wire(ServerVerifyExecutionTargetError, () =>
        run(input, () =>
          useOwner(async (client) => {
            // The fixture has no general verify RPC. Its authenticated listing proves directory access
            // and returns the resolved path (or the remote home if no cwd was supplied).
            const { path } = await list(client, {
              executionTargetId,
              ...(input.cwd === undefined ? {} : { path: input.cwd }),
            });
            // Selecting this folder for a workspace approves the alias settings first used.
            await aliasGuard.recordSave(client);
            return {
              executionTargetId,
              cwd: path,
              message: `Connected to ${host}. Remote path resolved to ${path}.`,
              remoteAgent: { status: "disabled" },
            };
          }),
        ),
      ),
    close: () =>
      (closing ??= queue.then(async () => {
        challenge = undefined;
        await (await owner?.catch(() => undefined))?.close();
      })),
  };
}
