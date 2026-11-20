import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { RemoteBackendIdentity } from "./authority.ts";
import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";

export type LocalSupervisorAuthorityIdentity = Pick<
  RemoteBackendIdentity,
  "authority" | "installationFingerprint"
>;
export interface LocalSupervisorBackendTuple {
  readonly backend_home: string;
  readonly backend_home_dev: string;
  readonly backend_home_ino: string;
  readonly backend_state: string;
  readonly backend_state_dev: string;
  readonly backend_state_ino: string;
}
export interface LocalSupervisorAuthorityRecord extends LocalSupervisorBackendTuple {
  readonly version: "1";
  readonly authority: string;
  readonly installation: string;
  readonly agent_root: string;
}
export const LOCAL_SUPERVISOR_BACKEND_TUPLE_KEYS = [
  "backend_home",
  "backend_home_dev",
  "backend_home_ino",
  "backend_state",
  "backend_state_dev",
  "backend_state_ino",
] as const;
const KEYS = [
  "version",
  "authority",
  "installation",
  "agent_root",
  ...LOCAL_SUPERVISOR_BACKEND_TUPLE_KEYS,
] as const;
const fingerprint = /^sha256:[a-f0-9]{64}$/;
export function expectedLocalSupervisorAuthority(
  root: string,
  stat: Pick<BigIntStats, "uid" | "dev" | "ino">,
  identity: LocalSupervisorAuthorityIdentity,
  backend: LocalSupervisorBackendTuple,
): LocalSupervisorAuthorityRecord {
  if (
    !/^[a-f0-9]{32}$/.test(identity.authority.authorityId) ||
    !fingerprint.test(identity.installationFingerprint)
  )
    throw new Error("Invalid backend installation identity for account ownership.");
  const digest = createHash("sha256")
    .update(
      [
        "bigbud.local-supervisor.authority.v1",
        root,
        stat.uid.toString(),
        stat.dev.toString(),
        stat.ino.toString(),
        identity.authority.authorityId,
        identity.installationFingerprint,
      ].join("\0"),
    )
    .digest("hex");
  return Object.freeze({
    ...backend,
    version: "1",
    authority: identity.authority.authorityId,
    installation: identity.installationFingerprint,
    agent_root: `sha256:${digest}`,
  });
}
export function encodeLocalSupervisorAuthority(record: LocalSupervisorAuthorityRecord): string {
  return KEYS.map((key) => `${key}=${record[key]}\n`).join("");
}
export function decodeLocalSupervisorAuthority(text: string): LocalSupervisorAuthorityRecord {
  if (Buffer.byteLength(text) > 16 * 1024)
    throw new Error("Account authority reservation is oversized.");
  const fields = new Map<string, string>();
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (
      index < 1 ||
      !KEYS.some((name) => name === key) ||
      fields.has(key) ||
      !value ||
      hasLocalSupervisorServiceControls(value)
    )
      throw new Error("Unknown or malformed account authority reservation.");
    fields.set(key, value);
  }
  const field = (key: string) => {
    const value = fields.get(key);
    if (value === undefined) throw new Error("Incomplete authority reservation.");
    return value;
  };
  if (
    fields.size !== KEYS.length ||
    field("version") !== "1" ||
    !/^[a-f0-9]{32}$/.test(field("authority")) ||
    !fingerprint.test(field("installation")) ||
    !fingerprint.test(field("agent_root"))
  )
    throw new Error("Unknown account authority reservation identity.");
  for (const key of ["backend_home", "backend_state"]) {
    const path = field(key);
    if (!isAbsolute(path) || normalize(path) !== path)
      throw new Error("Noncanonical backend reservation path.");
  }
  for (const key of [
    "backend_home_dev",
    "backend_home_ino",
    "backend_state_dev",
    "backend_state_ino",
  ])
    if (!/^(0|[1-9][0-9]{0,19})$/.test(field(key)))
      throw new Error("Invalid backend reservation tuple.");
  return Object.freeze({
    version: "1",
    authority: field("authority"),
    installation: field("installation"),
    agent_root: field("agent_root"),
    backend_home: field("backend_home"),
    backend_home_dev: field("backend_home_dev"),
    backend_home_ino: field("backend_home_ino"),
    backend_state: field("backend_state"),
    backend_state_dev: field("backend_state_dev"),
    backend_state_ino: field("backend_state_ino"),
  });
}
