import { Schema } from "effect";
import { RemoteAgentRuntimeSchema, validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { isRemoteAgentControllerAlive } from "./remoteAgentController.ts";
import { RemoteAgentShellLaunch, remoteAgentPtyRequestDigest } from "./remoteAgentShellLaunch.ts";

const InputIdentitySchema = Schema.Struct({
  sequence: Schema.Number,
  sha256: Schema.String,
  byteLength: Schema.Number,
});
const InputAuthoritySchema = Schema.Struct({
  id: Schema.String,
  pid: Schema.Number,
  startedAt: Schema.String,
  nonce: Schema.String,
});
const InputResolutionSchema = Schema.Struct({
  ...InputIdentitySchema.fields,
  outcome: Schema.Literals(["written", "failed-before-write", "not-admitted"]),
  writerUsable: Schema.Boolean,
});

const OwnerSchema = Schema.Struct({
  interruptionReason: Schema.optional(Schema.Literals(["restart"])),
  controllerId: Schema.optional(Schema.String),
  controllerPid: Schema.optional(Schema.Number),
  controllerStartedAt: Schema.optional(Schema.String),
  invocationId: Schema.optional(Schema.String),
  reservationId: Schema.optional(Schema.String),
  ownerKey: Schema.String,
  target: Schema.String,
  connectionId: Schema.String,
  runtime: RemoteAgentRuntimeSchema,
  epoch: Schema.String,
  resourceId: Schema.String,
  digest: Schema.String,
  // Immutable requested launch only; never interpret this as confirmed running identity.
  shellLaunch: Schema.optional(RemoteAgentShellLaunch),
  terminalCwd: Schema.optional(Schema.String),
  state: Schema.Literals(["prepared", "may-have-been-sent", "terminal", "outcome-unknown"]),
  outputSequence: Schema.Number,
  nextInputSequence: Schema.Number,
  inputAcknowledged: Schema.Number,
  inputAuthority: Schema.optional(InputAuthoritySchema),
  pendingInput: Schema.optional(InputIdentitySchema),
  inputResolved: Schema.optional(Schema.Number),
  inputResolution: Schema.optional(InputResolutionSchema),
});
export type RemoteAgentOwner = typeof OwnerSchema.Type;
export type RemoteAgentInterruptionReason = "restart";
export type RemoteAgentInputIdentity = typeof InputIdentitySchema.Type;
export type RemoteAgentInputResolution = typeof InputResolutionSchema.Type;

function assertBoundedIdentity(value: string, label: string, max = 256): void {
  if (value.length === 0 || value.length > max || !/^[\x21-\x7e]+$/.test(value))
    throw new Error(`Invalid durable owner ${label}.`);
}
export interface RemoteAgentConnectionBindings {
  readonly getBinding: (target: string) => Promise<RemoteAgentRuntimeBinding | undefined>;
  readonly bindConnection: (
    target: string,
    connectionId: string,
    binding: RemoteAgentRuntimeBinding,
  ) => Promise<void>;
  readonly hasDurableReferences?: (target: string, connectionId: string) => Promise<boolean>;
  readonly listConnectionIds?: (target: string) => Promise<ReadonlyArray<string>>;
}
export interface RemoteAgentOwnerStore extends RemoteAgentConnectionBindings {
  /** Read-only keyset discovery. Missing routes or live resources never imply exit. */
  readonly listTerminalOwners?: (
    target: string,
    after?: string,
    limit?: number,
  ) => Promise<{
    readonly owners: ReadonlyArray<RemoteAgentOwner>;
    readonly nextCursor: string;
  }>;
  readonly get: (ownerKey: string) => Promise<RemoteAgentOwner | undefined>;
  readonly reserve: (
    owner: RemoteAgentOwner,
    replaceTerminal?: boolean,
    expectedTarget?: string,
  ) => Promise<RemoteAgentOwner>;
  readonly rollbackPrepared?: (
    ownerKey: string,
    resourceId: string,
    expectedTarget?: string,
  ) => Promise<boolean>;
  readonly update: (
    ownerKey: string,
    transition: (owner: RemoteAgentOwner) => RemoteAgentOwner,
    expectedTarget?: string,
  ) => Promise<RemoteAgentOwner>;
  readonly referencedBuildIds: (target: string) => Promise<ReadonlySet<string>>;
  /** Targets with a durable selected connection, used for restart discovery. */
  readonly knownTargets?: () => Promise<ReadonlyArray<string>>;
  /** Remove only bounded, terminal history; active and uncertain routes are never eligible. */
  readonly pruneTerminal?: (expectedTarget?: string) => Promise<number>;
  /** Mark only this target’s non-terminal resources on an old runtime as outcome-unknown. */
  readonly reconcileRuntime?: (target: string, generation: string, epoch: string) => Promise<void>;
}

export function parseRemoteAgentBinding(text: string): RemoteAgentRuntimeBinding {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      runtime: RemoteAgentRuntimeSchema,
      expectedEpoch: Schema.String,
      connectionId: Schema.String,
    }),
  )(JSON.parse(text));
  validateRemoteAgentRuntime(value.runtime);
  if (!value.expectedEpoch || !value.connectionId)
    throw new Error("Incomplete durable connection binding.");
  return value;
}

export function parseRemoteAgentOwner(text: string): RemoteAgentOwner {
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Owner route is too large.");
  const owner = Schema.decodeUnknownSync(OwnerSchema)(JSON.parse(text));
  validateRemoteAgentRuntime(owner.runtime);
  if (owner.controllerId) assertBoundedIdentity(owner.controllerId, "controller id");
  if (owner.controllerStartedAt)
    assertBoundedIdentity(owner.controllerStartedAt, "controller start");
  if (
    owner.controllerPid !== undefined &&
    (!Number.isSafeInteger(owner.controllerPid) || owner.controllerPid <= 0)
  )
    throw new Error("Invalid durable controller identity.");
  for (const [label, value] of [
    ["owner key", owner.ownerKey],
    ["target", owner.target],
    ["connection id", owner.connectionId],
    ["epoch", owner.epoch],
    ["resource id", owner.resourceId],
  ] as const)
    assertBoundedIdentity(value, label);
  if (!/^[a-f0-9]{64}$/.test(owner.digest)) throw new Error("Invalid durable owner identity.");
  if (owner.terminalCwd !== undefined) {
    if (
      !owner.ownerKey.startsWith("terminal:") ||
      !owner.terminalCwd.startsWith("/") ||
      Buffer.byteLength(owner.terminalCwd) > 4096 ||
      owner.terminalCwd.includes("\0")
    )
      throw new Error("Invalid durable terminal directory.");
    const digest = Buffer.from(
      remoteAgentPtyRequestDigest({
        target: owner.target,
        cwd: owner.terminalCwd,
        ...(owner.shellLaunch ? { shellLaunch: owner.shellLaunch } : {}),
      }),
    ).toString("hex");
    if (digest !== owner.digest) throw new Error("Durable terminal directory identity conflict.");
  }
  if (owner.shellLaunch) {
    if (!owner.ownerKey.startsWith("terminal:"))
      throw new Error("Shell launch intent requires a terminal owner.");
    const digest = Buffer.from(
      remoteAgentPtyRequestDigest({
        target: owner.target,
        cwd: owner.shellLaunch.cwd,
        shellLaunch: owner.shellLaunch,
      }),
    ).toString("hex");
    if (owner.digest !== digest) throw new Error("Durable shell launch identity conflict.");
  }
  if (
    ![owner.outputSequence, owner.nextInputSequence, owner.inputAcknowledged].every(
      (sequence) => Number.isSafeInteger(sequence) && sequence >= 0,
    ) ||
    owner.nextInputSequence <= owner.inputAcknowledged
  )
    throw new Error("Invalid durable owner sequence.");
  if (
    new Set(
      [owner.controllerId, owner.controllerPid, owner.controllerStartedAt].map(
        (value) => value !== undefined,
      ),
    ).size > 1
  )
    throw new Error("Incomplete durable controller identity.");
  validateInputMetadata(owner);
  return owner;
}

function validateInputMetadata(owner: RemoteAgentOwner): void {
  const authority = owner.inputAuthority;
  if (authority) {
    assertBoundedIdentity(authority.id, "input controller");
    assertBoundedIdentity(authority.startedAt, "input controller start");
    assertBoundedIdentity(authority.nonce, "input observer", 128);
    if (!Number.isSafeInteger(authority.pid) || authority.pid <= 0)
      throw new Error("Invalid input controller PID.");
  }
  for (const identity of [owner.pendingInput, owner.inputResolution]) {
    if (!identity) continue;
    if (
      !Number.isSafeInteger(identity.sequence) ||
      identity.sequence < 1 ||
      !Number.isSafeInteger(identity.byteLength) ||
      identity.byteLength < 0 ||
      identity.byteLength > 64 * 1024 ||
      !/^[a-f0-9]{64}$/.test(identity.sha256)
    )
      throw new Error("Invalid durable input identity.");
  }
  if (owner.inputResolved === undefined) {
    if (owner.pendingInput || owner.inputResolution)
      throw new Error("Input receipt metadata requires a resolved watermark.");
    return; // Legacy gaps remain unknown; never synthesize their missing identity.
  }
  const resolved = owner.inputResolved;
  if (
    !authority ||
    !Number.isSafeInteger(resolved) ||
    resolved < owner.inputAcknowledged ||
    owner.nextInputSequence !== resolved + (owner.pendingInput ? 2 : 1) ||
    (owner.pendingInput && owner.pendingInput.sequence !== resolved + 1) ||
    (owner.inputResolution && owner.inputResolution.sequence !== resolved) ||
    (owner.inputResolution?.outcome === "written" && owner.inputAcknowledged !== resolved) ||
    (owner.inputResolution &&
      owner.inputResolution.outcome !== "written" &&
      owner.inputAcknowledged >= resolved)
  )
    throw new Error("Invalid durable input receipt ordering.");
}

let configured: RemoteAgentOwnerStore | undefined;
export function configureRemoteAgentOwners(store: RemoteAgentOwnerStore): void {
  configured = store;
}
export function remoteAgentOwners(): RemoteAgentOwnerStore {
  if (!configured)
    throw new Error("Remote owner recovery is not initialized; work was not dispatched.");
  return configured;
}

/** Reclaims only a prepared reservation whose owning server controller is proven dead. */
export async function reclaimDeadPreparedOwner(
  store: RemoteAgentOwnerStore,
  owner: RemoteAgentOwner | undefined,
): Promise<RemoteAgentOwner | undefined> {
  if (
    !owner ||
    owner.state !== "prepared" ||
    !owner.controllerId ||
    owner.controllerPid === undefined
  ) {
    return owner;
  }
  if (
    await isRemoteAgentControllerAlive({
      id: owner.controllerId,
      pid: owner.controllerPid,
      startedAt: owner.controllerStartedAt ?? "",
    })
  ) {
    return owner;
  }
  if (await store.rollbackPrepared?.(owner.ownerKey, owner.resourceId)) return undefined;
  return await store.get(owner.ownerKey);
}
