import { readFileSync, readdirSync } from "node:fs";
import type { ChallengeFields, ClientHello } from "@bigbud/contracts/terminal-owner/auth";
import type { Scope } from "@bigbud/contracts/terminal-owner/identity";
import type { OwnerShutdownInventory } from "@bigbud/contracts/terminal-owner/shutdown";
import type { AuthExpectations } from "./auth";
import { ownerLimits } from "./limits";
import { recordDigest } from "./auth";

export const id = (byte: number) => new Uint8Array(32).fill(byte);
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export const vectors: {
  records: Record<string, unknown>;
  canonical: Record<string, string>;
  expected: Record<string, string>;
  types: Record<string, string>;
} = { records: {}, canonical: {}, expected: {}, types: {} };
const directory = new URL("./fixtures/canonical/", import.meta.url);
const artifacts = new Map<
  string,
  { input?: unknown; canonical?: string; type?: string; reservations?: unknown[] }
>();
for (const file of readdirSync(directory).toSorted()) {
  const value = JSON.parse(readFileSync(new URL(file, directory), "utf8"), (_key, operand) =>
    operand && typeof operand === "object" && "$bytes" in operand
      ? Uint8Array.from(Buffer.from(operand.$bytes, "hex"))
      : operand,
  );
  if (file === "expected.json") vectors.expected = value;
  else artifacts.set(file.replace(/\.json$/, ""), value);
}
function resolveReservations(value: unknown): unknown {
  if (!value || typeof value !== "object" || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(resolveReservations);
  if ("$reservations" in value)
    return (value.$reservations as string[]).flatMap((name) => artifacts.get(name)!.reservations!);
  return Object.fromEntries(
    Object.entries(value).map(([name, operand]) => [name, resolveReservations(operand)]),
  );
}
for (const [name, artifact] of artifacts) {
  if (artifact.reservations) continue;
  vectors.records[name] = resolveReservations(artifact.input);
  vectors.canonical[name] = artifact.canonical!;
  vectors.types[name] = artifact.type ?? name;
}
export function rootFixture() {
  const hello = structuredClone(vectors.records.ClientHello) as ClientHello;
  const fields = structuredClone(vectors.records.ChallengeFields) as ChallengeFields;
  const key = Uint8Array.from(Buffer.from(vectors.expected.rootKey!, "hex"));
  const expected: AuthExpectations = {
    profile: fields.profile,
    artifactSetDigest: fields.artifactSetDigest,
    ownerEpoch: fields.ownerEpoch,
    endpointInstance: fields.endpointInstance,
    verifiedPeer: hello.rootIntent!.subject,
    generations: fields.generations,
    credential: {
      kind: hello.kind,
      role: hello.role,
      lane: hello.lane,
      credentialId: hello.credentialId,
    },
  };
  return { hello, fields, key, expected };
}
export function scopeFixture(role: 2 | 3 | 4 = 2): Scope {
  if (role === 4) return structuredClone(vectors.records.CleanupScope) as Scope;
  const { hello } = rootFixture();
  const capabilities = role === 2 ? ([1, 2, 3, 4, 5, 9] as const) : ([6, 7, 8, 9] as const);
  return {
    role,
    use: 1,
    revision: "1",
    generations: { main: "1", controller: role === 3 ? "0" : "1", host: role === 3 ? "1" : "0" },
    process: hello.rootIntent!.subject,
    artifactSetDigest: id(2),
    createBudget: role === 2 ? 32 : 0,
    capabilities,
    ptys: [{ ownerEpoch: id(1), ptyId: id(11), terminalGeneration: "1", capabilities }],
    shutdownId: id(0),
  };
}
export function inventoryFixture(): OwnerShutdownInventory {
  return structuredClone(vectors.records.OwnerShutdownInventory) as OwnerShutdownInventory;
}
export function scopedFixture() {
  const root = rootFixture();
  const { rootIntent: _intent, ...hello } = root.hello;
  const { rootIntent: _echo, ...fields } = root.fields;
  const scope = scopeFixture();
  const limits = ownerLimits(2);
  const credential = { role: 2, kind: 2, lane: 1, credentialId: id(12) } as const;
  return {
    hello: { ...hello, ...credential },
    fields: {
      ...fields,
      ...credential,
      scope,
      scopeDigest: recordDigest("Scope", scope),
      generations: scope.generations,
      limits,
      limitsDigest: recordDigest("Limits", limits),
    },
    key: root.key,
    expected: { ...root.expected, scope, generations: scope.generations, credential },
  };
}
