import { Schema } from "effect";
import { RemoteAgentRuntimeSchema, validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { isRemoteAgentControllerAlive } from "./remoteAgentController.ts";

const OwnerSchema = Schema.Struct({
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
  state: Schema.Literals(["prepared", "may-have-been-sent", "terminal", "outcome-unknown"]),
  outputSequence: Schema.Number,
  nextInputSequence: Schema.Number,
  inputAcknowledged: Schema.Number,
});
export type RemoteAgentOwner = typeof OwnerSchema.Type;

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
  readonly get: (ownerKey: string) => Promise<RemoteAgentOwner | undefined>;
  readonly reserve: (
    owner: RemoteAgentOwner,
    replaceTerminal?: boolean,
  ) => Promise<RemoteAgentOwner>;
  readonly rollbackPrepared?: (ownerKey: string, resourceId: string) => Promise<boolean>;
  readonly update: (
    ownerKey: string,
    transition: (owner: RemoteAgentOwner) => RemoteAgentOwner,
  ) => Promise<RemoteAgentOwner>;
  readonly referencedBuildIds: (target: string) => Promise<ReadonlySet<string>>;
  /** Targets with a durable selected connection, used for restart discovery. */
  readonly knownTargets?: () => Promise<ReadonlyArray<string>>;
  /** Remove only bounded, terminal history; active and uncertain routes are never eligible. */
  readonly pruneTerminal?: () => Promise<number>;
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
  return owner;
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
