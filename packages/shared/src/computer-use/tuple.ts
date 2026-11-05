import { CUA_DRIVER_VERSION } from "../cua-driver/release.ts";
import {
  CUA_DRIVER_0_38_0_DARWIN_ARM64_EVIDENCE,
  CUA_DRIVER_0_38_0_SOURCE,
} from "../cua-driver/release.v0_38_0.ts";
import { computerUseProtocol } from "./protocol.profile.ts";

/** Informational selection: no caller selects the replacement in this change. */
export const selectedComputerUseTuple = Object.freeze({
  kind: "legacy" as const,
  driverVersion: CUA_DRIVER_VERSION,
  supervised: false as const,
});

export const proposedComputerUseDriver = Object.freeze({
  version: "0.38.0" as const,
  source: CUA_DRIVER_0_38_0_SOURCE,
  // Historical static evidence only. Never reuse this hash for another target.
  darwinArm64: Object.freeze({
    archiveSha256: CUA_DRIVER_0_38_0_DARWIN_ARM64_EVIDENCE.archiveSha256,
    binarySha256: CUA_DRIVER_0_38_0_DARWIN_ARM64_EVIDENCE.binarySha256,
  }),
});

export const qualificationAreas = [
  "capture",
  "foreground",
  "background",
  "controls",
  "protectedTargets",
  "retirement",
  "launch",
  "navigation",
  "hostPermissions",
] as const;
export type QualificationArea = (typeof qualificationAreas)[number];
export type ComputerUsePlatform = "darwin" | "win32" | "linux";

/** Immutable identity of a complete candidate. Evidence hashes identify audited
 * records; their presence is NOT verification of those records or qualification.
 * No tuple-selection/cutover API is supplied until lifecycle/control gates exist.
 */
export interface ComputerUseTupleManifest {
  readonly format: 1;
  readonly id: string;
  readonly protocolMajor: 1;
  readonly protocolMinor: 0;
  readonly adapterVersion: 2;
  readonly backend: "mediated-mcp";
  readonly driverVersion: "0.38.0";
  readonly driverSource: string;
  readonly platform: ComputerUsePlatform;
  readonly arch: "arm64" | "x64";
  readonly archiveSha256: string;
  readonly binarySha256: string;
  readonly toolSchemaSha256: string;
  readonly policyFormat: 1;
  /** Immutable Driver dispatch-policy artifact, not dynamic user policy values. */
  readonly policySha256: string;
  readonly stateFormat: 1;
  readonly stateRoot: "per-user-computer-use-v1";
  readonly hostIdentity: string;
  readonly nativeClosure: ReadonlyArray<{
    readonly role: "guard" | "owner" | "worker" | "broker" | "library";
    readonly sha256: string;
    readonly codeIdentity: string;
  }>;
  readonly qualificationProfile: "computer-use-stage1-v1";
  readonly qualificationEvidence: Readonly<Record<QualificationArea, string>>;
}

export class ComputerUseTupleError extends Error {
  constructor() {
    super("Incomplete or incompatible computer-use tuple manifest.");
  }
}
function requireTuple(value: unknown): asserts value {
  if (!value) throw new ComputerUseTupleError();
}
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");

/** Validates identity shape only, never signs evidence or activates a runtime. */
export function parseComputerUseTupleManifest(input: unknown): ComputerUseTupleManifest {
  requireTuple(input && typeof input === "object" && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  const names = [
    "format",
    "id",
    "protocolMajor",
    "protocolMinor",
    "adapterVersion",
    "backend",
    "driverVersion",
    "driverSource",
    "platform",
    "arch",
    "archiveSha256",
    "binarySha256",
    "toolSchemaSha256",
    "policyFormat",
    "policySha256",
    "stateFormat",
    "stateRoot",
    "hostIdentity",
    "nativeClosure",
    "qualificationProfile",
    "qualificationEvidence",
  ];
  requireTuple(
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name)),
  );
  requireTuple(
    value.format === 1 &&
      identity(value.id) &&
      value.protocolMajor === computerUseProtocol.major &&
      value.protocolMinor === computerUseProtocol.minor &&
      value.adapterVersion === 2,
  );
  requireTuple(
    value.backend === "mediated-mcp" &&
      value.driverVersion === proposedComputerUseDriver.version &&
      value.driverSource === proposedComputerUseDriver.source,
  );
  requireTuple(
    ["darwin", "win32", "linux"].includes(value.platform as string) &&
      ["arm64", "x64"].includes(value.arch as string),
  );
  requireTuple(
    [value.archiveSha256, value.binarySha256, value.toolSchemaSha256, value.policySha256].every(
      hash,
    ),
  );
  requireTuple(
    value.policyFormat === 1 &&
      value.stateFormat === 1 &&
      value.stateRoot === "per-user-computer-use-v1" &&
      identity(value.hostIdentity),
  );
  requireTuple(value.qualificationProfile === computerUseProtocol.profile);
  const closure = value.nativeClosure;
  requireTuple(Array.isArray(closure) && closure.length >= 4 && closure.length <= 32);
  const roles: string[] = [];
  for (const item of closure) {
    requireTuple(
      item &&
        typeof item === "object" &&
        Object.keys(item).length === 3 &&
        ["guard", "owner", "worker", "broker", "library"].includes(item.role) &&
        hash(item.sha256) &&
        identity(item.codeIdentity),
    );
    roles.push(item.role);
  }
  requireTuple(
    ["guard", "owner", "worker", "broker"].every(
      (role) => roles.filter((item) => item === role).length === 1,
    ),
  );
  const evidence = value.qualificationEvidence;
  requireTuple(evidence && typeof evidence === "object" && !Array.isArray(evidence));
  requireTuple(
    Object.keys(evidence).length === qualificationAreas.length &&
      qualificationAreas.every((key) => hash((evidence as Record<string, unknown>)[key])),
  );
  // Return a detached, deeply frozen snapshot, not mutable authority supplied by a caller.
  return Object.freeze({
    ...value,
    nativeClosure: Object.freeze(closure.map((item) => Object.freeze({ ...item }))),
    qualificationEvidence: Object.freeze({ ...evidence }),
  }) as unknown as ComputerUseTupleManifest;
}
