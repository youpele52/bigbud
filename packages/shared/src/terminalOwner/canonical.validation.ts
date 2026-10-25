import type {
  ProcessIdentity,
  ProfileIdentity,
  RootIntent,
  Scope,
  Limits,
} from "@bigbud/contracts/terminal-owner/identity";
import type { ChallengeFields, ClientHello } from "@bigbud/contracts/terminal-owner/auth";
import type { OwnerShutdownInventory } from "@bigbud/contracts/terminal-owner/shutdown";
import { identityLayouts } from "./canonical.identity";
import { authLayouts } from "./canonical.auth";
import { validateLimits } from "./limits";
import { requireContract } from "./errors";

const layouts = { ...identityLayouts, ...authLayouts };
export const ROLE_CAPABILITIES: Readonly<Record<number, readonly number[]>> = {
  2: [1, 2, 3, 4, 5, 9],
  3: [6, 7, 8, 9],
  4: [9, 10],
};
export const zeroId = () => new Uint8Array(32);
export const isZero = (value: Uint8Array) => value.every((byte) => byte === 0);

function increasing(values: readonly number[]): boolean {
  return values.every((value, i) => i === 0 || value > values[i - 1]!);
}
function process(value: ProcessIdentity) {
  const birth = value.birth;
  requireContract(
    BigInt(value.pid) > 0n &&
      ((value.os === 1 &&
        ((birth[0] === 1 && birth.length === 9) ||
          (birth[0] === 2 &&
            birth.length === 13 &&
            new DataView(birth.buffer, birth.byteOffset).getUint32(9) < 1000000))) ||
        (value.os === 2 && birth[0] === 3 && birth.length === 9)),
    "PROCESS_IDENTITY_INVALID",
  );
}
function profile(value: ProfileIdentity) {
  requireContract(
    value.backend.os === value.os &&
      value.userData.os === value.os &&
      new TextEncoder().encode(value.channel).length <= 32 &&
      value.user.length <= 68,
    "PROFILE_INVALID",
  );
  requireContract(
    value.os === 1
      ? value.user.length === 8
      : value.user.length >= 8 &&
          value.user[0] === 1 &&
          value.user[1]! <= 15 &&
          value.user.length === 8 + value.user[1]! * 4,
    "PROFILE_INVALID",
  );
}
function intent(value: RootIntent) {
  const status = value.mode === 5;
  requireContract(
    status
      ? value.use === 3 &&
          value.op.sequence === "0" &&
          isZero(value.op.attemptId) &&
          value.op.expectedAuthorityRevision === "0"
      : value.use !== 3 && BigInt(value.op.sequence) > 0n && !isZero(value.op.attemptId),
    "ROOT_INTENT_INVALID",
  );
  requireContract(
    value.mode === 4 ? !isZero(value.handoverTicket) : isZero(value.handoverTicket),
    "ROOT_INTENT_INVALID",
  );
  if ([2, 3, 4].includes(value.mode))
    requireContract(
      BigInt(value.expectedMainGeneration) > 0n && !isZero(value.expectedMainSession),
      "ROOT_INTENT_INVALID",
    );
}
function scope(value: Scope) {
  const allowed = ROLE_CAPABILITIES[value.role];
  requireContract(
    allowed &&
      increasing(value.capabilities) &&
      value.capabilities.every((cap) => allowed.includes(cap)) &&
      BigInt(value.revision) > 0n &&
      BigInt(value.generations.main) > 0n &&
      value.createBudget <= 32,
    "SCOPE_INVALID",
  );
  requireContract(
    value.role === 4
      ? value.use === 3 &&
          !isZero(value.shutdownId) &&
          value.capabilities.join() === "9,10" &&
          value.ptys.length === 0 &&
          !!value.cleanupInventory &&
          equalBytes(value.cleanupInventory.shutdownId, value.shutdownId) &&
          equalBytes(value.cleanupInventory.ownerEpoch, value.process.ownerEpoch)
      : value.use !== 3 && isZero(value.shutdownId) && value.cleanupInventory === undefined,
    "SCOPE_INVALID",
  );
  requireContract(
    value.role === 2
      ? value.use <= 2 &&
          BigInt(value.generations.controller) > 0n &&
          value.generations.host === "0"
      : value.createBudget === 0 &&
          (value.role === 3
            ? value.use === 1 &&
              value.generations.controller === "0" &&
              BigInt(value.generations.host) > 0n
            : value.generations.host === "0" && BigInt(value.generations.controller) > 0n),
    "SCOPE_INVALID",
  );
  let previous: Uint8Array | undefined;
  for (const entry of value.ptys) {
    requireContract(
      BigInt(entry.terminalGeneration) > 0n &&
        increasing(entry.capabilities) &&
        entry.capabilities.every((cap) => value.capabilities.includes(cap)) &&
        equalBytes(entry.ownerEpoch, value.process.ownerEpoch),
      "SCOPE_INVALID",
    );
    requireContract(!previous || compareBytes(previous, entry.ptyId) < 0, "SCOPE_ORDER");
    previous = entry.ptyId;
  }
}
function hello(value: ClientHello) {
  requireContract(
    value.major === 1 && value.minorMin === 1 && value.minorMax === 1,
    "AUTH_VERSION",
  );
  const root = value.kind === 1;
  requireContract(
    root === !!value.rootIntent &&
      (value.kind === 3) === !!value.replacement &&
      (value.kind === 4) === !!value.laneBinding,
    "AUTH_PRESENCE",
  );
  requireContract(
    root
      ? value.role === 1 &&
          isZero(value.credentialId) &&
          value.lane === (value.rootIntent!.mode === 5 ? 2 : 1)
      : !isZero(value.credentialId),
    "AUTH_ROLE",
  );
  if (!root && value.kind !== 4) requireContract(value.role !== 1 && value.lane === 1, "AUTH_ROLE");
  if (value.role === 4)
    requireContract(value.kind === 2 || (value.kind === 4 && value.lane === 2), "AUTH_ROLE");
}
function challenge(value: ChallengeFields) {
  requireContract(
    value.major === 1 &&
      value.minor === 1 &&
      BigInt(value.ttlRemainingMs) > 0n &&
      BigInt(value.ttlRemainingMs) <= 5000n,
    "AUTH_VERSION",
  );
  requireContract(
    value.kind === 1
      ? value.role === 1 && !value.scope && isZero(value.scopeDigest)
      : !!value.scope === (value.role !== 1),
    "AUTH_SCOPE",
  );
  hello({ ...value, minorMin: value.minor, minorMax: value.minor, profileDigest: zeroId() });
  validateLimits(value.limits, value.role, value.rootIntent?.mode === 5);
}

/** Byte comparison only, not constant-time secret/MAC comparison. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0;
}

export function validateRecordSemantics(name: keyof typeof layouts, input: unknown): void {
  const value = input as Record<string, unknown>;
  if (name === "ProcessIdentity") process(input as ProcessIdentity);
  if (name === "ProfileIdentity") profile(input as ProfileIdentity);
  if (name === "RootIntent") intent(input as RootIntent);
  if (name === "Scope") scope(input as Scope);
  if (name === "ShutdownInventoryBinding")
    requireContract(
      BigInt(value.parentRootSequence as string) > 0n && !isZero(value.inventoryCut as Uint8Array),
      "INVENTORY_INVALID",
    );
  if (name === "ShutdownPtyReservation")
    requireContract(
      (value.slot as number) < 64 && BigInt(value.terminalGeneration as string) > 0n,
      "INVENTORY_INVALID",
    );
  if (name === "OwnerShutdownInventory") {
    const ptys = (input as OwnerShutdownInventory).ptys;
    requireContract(
      ptys.every(
        (entry, index) =>
          entry.slot === index &&
          ptys.slice(0, index).every((prior) => !equalBytes(prior.ptyId, entry.ptyId)),
      ),
      "INVENTORY_INVALID",
    );
  }
  if (name === "ClientHello") hello(input as ClientHello);
  if (name === "ChallengeFields") challenge(input as ChallengeFields);
  if (name === "DirectoryIdentity") {
    const os = value.os;
    const path = value.path as Uint8Array;
    requireContract(
      (value.volume as Uint8Array).length === (os === 1 ? 8 : 16) &&
        (value.fileId as Uint8Array).length === (os === 1 ? 8 : 16) &&
        path.length <= 1024 &&
        path.length > 0,
      "DIRECTORY_INVALID",
    );
    if (os === 1) requireContract(path[0] === 47 && !path.includes(0), "DIRECTORY_INVALID");
    else {
      requireContract(path.length % 2 === 0, "DIRECTORY_INVALID");
      const units = Array.from({ length: path.length / 2 }, (_, i) =>
        new DataView(path.buffer, path.byteOffset).getUint16(i * 2, true),
      );
      requireContract(
        !units.includes(0) &&
          ((units[0] === 92 && units[1] === 92) ||
            (units[1] === 58 && (units[2] === 92 || units[2] === 47))),
        "DIRECTORY_INVALID",
      );
    }
  }
  if (name === "Limits")
    requireContract(
      (input as Limits).entries.length === 24 &&
        (input as Limits).entries.every((entry, i) => entry.key === i + 1),
      "LIMITS_INVALID",
    );
  if (name === "LaneBinding")
    requireContract(
      BigInt(value.serial as string) > 0n &&
        (value.role === 1
          ? value.lane !== 3 &&
            isZero(value.scopeDigest as Uint8Array) &&
            value.scopeRevision === "0"
          : !isZero(value.scopeDigest as Uint8Array) && BigInt(value.scopeRevision as string) > 0n),
      "LANE_INVALID",
    );
  if (name === "SessionFrame" || name === "SessionFrameFields")
    requireContract(BigInt(value.sequence as string) > 0n, "SEQUENCE_GAP");
  if (name === "CleanupRef")
    requireContract(
      BigInt(value.parentRootSequence as string) > 0n &&
        (value.slot as number) < [0, 64, 32, 16][value.class as number]!,
      "CLEANUP_REF_INVALID",
    );
  for (const [key, operand] of layouts[name]) {
    const type = operand.replace(/\?$/, "").replace(/\[\]$/, "");
    const child = value[key];
    if (child === undefined || !(type in layouts)) continue;
    for (const nested of operand.endsWith("[]") ? (child as readonly unknown[]) : [child])
      validateRecordSemantics(type as keyof typeof layouts, nested);
  }
}
