import { token } from "../cutover/evidence.ts";
import { slots, verificationModes, type Slot } from "./catalog.ts";

export function object<K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`Expected exactly these fields: ${keys.join(", ")}`);
  }
  return value as Record<K, unknown>;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Expected a nonempty array");
  return value;
}

export function digest(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Expected a lowercase SHA-256 digest");
  }
  return value;
}

export function positive(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Expected a positive integer");
  }
  return value;
}

export function image(value: unknown) {
  const fields = object(value, ["id", "build", "sha256"]);
  return { id: token(fields.id), build: token(fields.build), sha256: digest(fields.sha256) };
}

function identity(value: unknown, slot: Slot) {
  const fields = object(value, [
    "a",
    "b",
    "artifactVerification",
    "dbDomain",
    "schemaA",
    "schemaB",
    "migration",
    "platform",
    "owner",
    "askpass",
  ]);
  const a = image(fields.a);
  const b = image(fields.b);
  const schemaA = positive(fields.schemaA);
  const schemaB = positive(fields.schemaB);
  const migration = positive(fields.migration);
  if (a.id === b.id || a.build === b.build || a.sha256 === b.sha256) {
    throw new Error("A and B must be distinct builds and artifacts");
  }
  if (schemaA !== schemaB || schemaA < migration) {
    throw new Error("A and B need the same schema ceiling including the preparatory migration");
  }
  const artifactVerification = token(fields.artifactVerification);
  if (!verificationModes(slot).includes(artifactVerification)) {
    throw new Error("Artifact verification mode does not match the profile/target");
  }
  const platformFields = object(fields.platform, [
    "os",
    "arch",
    "osBuild",
    "abi",
    "runtimeBuild",
    "sshOrigin",
    "sshVersion",
    "sshSha256",
  ]);
  const platform = {
    os: token(platformFields.os),
    arch: token(platformFields.arch),
    osBuild: token(platformFields.osBuild),
    abi: token(platformFields.abi),
    runtimeBuild: token(platformFields.runtimeBuild),
    sshOrigin: token(platformFields.sshOrigin),
    sshVersion: token(platformFields.sshVersion),
    sshSha256: digest(platformFields.sshSha256),
  };
  if (platform.os !== slot.os || platform.arch !== slot.arch) {
    throw new Error("Platform identity does not match the slot target");
  }
  if (
    (slot.profile === "R" || (slot.profile === "N" && slot.os === "linux")) &&
    !/^gnu(?:-|$)/.test(platform.abi)
  ) {
    throw new Error("Expected the Linux GNU native ABI for this artifact");
  }
  if (slot.profile === "N" && slot.os === "win32" && !/^msvc(?:-|$)/.test(platform.abi)) {
    throw new Error("Expected the Windows MSVC native ABI for this artifact");
  }
  const runtime = { D: "electron", "V-E": "electron", "V-B": "bun", N: "node", R: "node" };
  if (!platform.runtimeBuild.startsWith(`${runtime[slot.profile]}-`)) {
    throw new Error("Runtime identity does not match the profile entry point");
  }
  const win11Build = /^win11-(\d+)(?:\.\d+)?$/.exec(platform.osBuild)?.[1];
  if (
    slot.inbox &&
    (platform.sshOrigin !== "windows-inbox" ||
      !/^OpenSSH_for_Windows_\d+\.\d+p\d+$/.test(platform.sshVersion) ||
      (slot.inbox === "win10-22h2"
        ? !/^19045(?:\.\d+)?$/.test(platform.osBuild) ||
          platform.sshVersion !== "OpenSSH_for_Windows_8.1p1"
        : !win11Build || Number(win11Build) < 22000))
  ) {
    throw new Error("Windows inbox product image, OS build or OpenSSH version mismatch");
  }
  const ownerFields = object(fields.owner, ["image", "protocol"]);
  const owner = { image: image(ownerFields.image), protocol: token(ownerFields.protocol) };
  const askpass = fields.askpass === null ? null : image(fields.askpass);
  if (askpass && !slot.inbox) throw new Error("Native Windows askpass is not applicable here");
  const digests = [a.sha256, b.sha256, platform.sshSha256, owner.image.sha256, askpass?.sha256];
  if (new Set(digests).size !== digests.length) throw new Error("Conflicting image identities");
  return {
    a,
    b,
    artifactVerification,
    dbDomain: token(fields.dbDomain),
    schemaA,
    schemaB,
    migration,
    platform,
    owner,
    askpass,
  };
}

const byId = new Map(slots.map((slot) => [slot.id, slot]));

export function binding(value: unknown) {
  const fields = object(value, ["slot", "cell", "disposition", "identity"]);
  const slot = byId.get(token(fields.slot));
  const cell = token(fields.cell);
  if (!slot) throw new Error("Unknown matrix slot");
  const disposition = fields.disposition;
  if (disposition === "required") {
    if (slot.disposition === "excluded")
      throw new Error(`${cell}: excluded slot cannot be required`);
    return { slot, cell, disposition, identity: identity(fields.identity, slot) } as const;
  }
  if (
    disposition === "unsupported" &&
    slot.disposition !== "required" &&
    fields.identity === null
  ) {
    return { slot, cell, disposition, identity: null } as const;
  }
  throw new Error(`${cell}: invalid disposition or missing required artifact identity`);
}

export type Binding = ReturnType<typeof binding>;

export function claim(value: unknown) {
  const fields = object(value, ["lane", "status", "result", "ref", "decision"]);
  const lane = token(fields.lane);
  if (fields.status !== "verified") throw new Error(`${lane}: expected a verified claim reference`);
  return {
    lane,
    result: token(fields.result),
    ref: token(fields.ref),
    decision: fields.decision === null ? null : token(fields.decision),
  };
}

export type Claim = ReturnType<typeof claim>;
