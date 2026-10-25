import { Schema } from "effect";
import { ShutdownInventoryBinding } from "./shutdown";
import {
  Bytes,
  Id,
  IssuedId,
  OS,
  Role,
  RootMode,
  RootUse,
  GrantUse,
  U64,
  U32,
  Capabilities,
} from "./primitives";

export const ProcessIdentity = Schema.Struct({
  os: OS,
  pid: U64,
  birth: Bytes,
  ownerEpoch: IssuedId,
});
export type ProcessIdentity = typeof ProcessIdentity.Type;
export const RootOp = Schema.Struct({
  sequence: U64,
  attemptId: Id,
  expectedAuthorityRevision: U64,
});
export type RootOp = typeof RootOp.Type;
export const RootIntent = Schema.Struct({
  mode: RootMode,
  use: RootUse,
  op: RootOp,
  expectedMainGeneration: U64,
  expectedMainSession: Id,
  subject: ProcessIdentity,
  handoverTicket: Id,
});
export type RootIntent = typeof RootIntent.Type;
export const Generations = Schema.Struct({ main: U64, controller: U64, host: U64 });
export type Generations = typeof Generations.Type;
export const DirectoryIdentity = Schema.Struct({
  os: OS,
  volume: Bytes,
  fileId: Bytes,
  path: Bytes,
});
export const ProfileIdentity = Schema.Struct({
  identityVersion: Schema.Literal(1),
  os: OS,
  user: Bytes,
  channel: Schema.String,
  namespace: Schema.Literals([1, 2]),
  backend: DirectoryIdentity,
  userData: DirectoryIdentity,
});
export type ProfileIdentity = typeof ProfileIdentity.Type;
export const PtyScopeEntry = Schema.Struct({
  ownerEpoch: IssuedId,
  ptyId: IssuedId,
  terminalGeneration: U64,
  capabilities: Capabilities,
});
export const Scope = Schema.Struct({
  role: Role,
  use: GrantUse,
  revision: U64,
  generations: Generations,
  process: ProcessIdentity,
  artifactSetDigest: Id,
  createBudget: U32,
  capabilities: Capabilities,
  ptys: Schema.Array(PtyScopeEntry).check(Schema.isMaxLength(32)),
  shutdownId: Id,
  cleanupInventory: Schema.optionalKey(ShutdownInventoryBinding),
});
export type Scope = typeof Scope.Type;
export const Limit = Schema.Struct({ key: U32, value: U64 });
export const Limits = Schema.Struct({ entries: Schema.Array(Limit).check(Schema.isMaxLength(24)) });
export type Limits = typeof Limits.Type;
export const ReplacementBinding = Schema.Struct({
  replacementId: IssuedId,
  oldGrantId: IssuedId,
  oldScopeRevision: U64,
  oldSession: IssuedId,
});
export const LaneBinding = Schema.Struct({
  ticketId: IssuedId,
  serial: U64,
  ownerEpoch: IssuedId,
  endpointInstance: IssuedId,
  parentSession: IssuedId,
  parentTranscript: Id,
  role: Role,
  scopeDigest: Id,
  scopeRevision: U64,
  generations: Generations,
  lane: Schema.Literals([2, 3, 4]),
  ttlMs: Schema.Literal("5000"),
});
export type LaneBinding = typeof LaneBinding.Type;
