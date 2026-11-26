import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";

import {
  ordinaryWindowsPickerPath,
  validateWindowsPickerAcl,
} from "./sshPicker.loopback.fixture.windows.acl.ts";
import {
  loadWindowsLoopbackPickerFixture,
  parseWindowsPickerFixtureManifest,
  validateWindowsPickerIdentity,
  validateWindowsPickerPin,
  windowsPickerFixturePaths,
} from "./sshPicker.loopback.fixture.windows.ts";

const hostPublicKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const manifest = {
  kind: "bigbud-windows-posix-picker-v1",
  host: "127.0.0.1",
  port: 2222,
  user: "picker",
  hostPublicKey,
};
const parse = (overrides: object = {}) =>
  parseWindowsPickerFixtureManifest(Buffer.from(JSON.stringify({ ...manifest, ...overrides })));

function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function wire(value: string | Buffer) {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}

function syntheticIdentity({
  comment = "bigbud-windows-picker-fixture",
  cipher = "none",
  changeSeed = false,
  mismatchChecks = false,
} = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d!, "base64url");
  if (changeSeed) seed[0] = seed[0]! ^ 1;
  const publicKey = Buffer.from(jwk.x!, "base64url");
  const publicBlob = Buffer.concat([wire("ssh-ed25519"), wire(publicKey)]);
  const privateBlob = Buffer.concat([
    u32(0x10203040),
    u32(mismatchChecks ? 0 : 0x10203040),
    publicBlob,
    wire(Buffer.concat([seed, publicKey])),
    wire(comment),
  ]);
  const padding = Buffer.from(
    Array.from({ length: (8 - (privateBlob.length % 8)) % 8 }, (_, i) => i + 1),
  );
  const binary = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    wire(cipher),
    wire("none"),
    u32(0),
    u32(1),
    wire(publicBlob),
    wire(Buffer.concat([privateBlob, padding])),
  ]);
  return Buffer.from(
    [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      ...binary.toString("base64").match(/.{1,70}/g)!,
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n"),
  );
}

const sid = "S-1-5-21-111-222-333-1001";
const admin = "S-1-5-32-544";
const users = "S-1-5-32-545";
const rule = (principal: string, rights = 0x1f01ff, inheritOnly = false) => ({
  sid: principal,
  rights,
  inheritOnly,
  allow: true,
});
const systemAncestor = { owner: admin, rules: [rule(admin), rule(users, 0x1200a9)] };
const privateEntry = { owner: sid, rules: [rule(sid), rule(admin)] };
const validateAcl = (ancestor: unknown, entry: unknown) =>
  validateWindowsPickerAcl([false, true], { sid, entries: [ancestor, entry] });

it("binds only an explicitly attested disposable POSIX IPv4 loopback fixture", () => {
  expect(parse()).toEqual({
    loopback: "127.0.0.1",
    port: 2222,
    user: "picker",
    host: "[127.0.0.1]:2222",
    expectedFingerprint: "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk",
    pin: `[127.0.0.1]:2222 ${hostPublicKey}`,
  });
});

it.each([
  { host: "localhost" },
  { host: "127.0.0.2" },
  { host: "::1" },
  { host: "127.1" },
  { host: "127.0.0.1 " },
  { port: 22 },
  { port: 65536 },
  { port: "2222" },
  { port: 2222.5 },
  { user: "root" },
  { user: "-v" },
  { user: "picker\n" },
  { user: "admin@host" },
  { identity: "C:/Users/Desktop/.ssh/id_ed25519" },
  { knownHosts: "C:/Users/Desktop/.ssh/known_hosts" },
  { proxyCommand: "ignored" },
  { kind: "native-windows-sshd" },
  { hostPublicKey: hostPublicKey.replace("AAAAIA", "AAAAJA") },
  { hostPublicKey: `${hostPublicKey} comment` },
])("rejects alternate or malformed manifest fields: %j", (overrides) => {
  expect(() => parse(overrides)).toThrow(/Invalid Windows picker fixture manifest/);
});

it("allows only an empty or exact and single scoped Ed25519 pin", () => {
  const { pin } = parse();
  for (const record of ["", `${pin}\n`, `${pin}\r\n`]) {
    expect(() => validateWindowsPickerPin(Buffer.from(record), pin)).not.toThrow();
  }
  for (const record of [
    pin,
    `${pin}\n${pin}\n`,
    `${pin.slice(0, -1)}B\n`,
    `${pin.replace(":2222", ":2223")}\n`,
    `${pin.replace("[127.0.0.1]:2222", "*")}\n`,
    `# comment\n${pin}\n`,
    "\n",
  ]) {
    expect(() => validateWindowsPickerPin(Buffer.from(record), pin)).toThrow(/pin must be empty/);
  }
});

it("checks the OpenSSH private key structure, type, derived public key, and embedded fixture marker", () => {
  expect(() => validateWindowsPickerIdentity(syntheticIdentity())).not.toThrow();
  for (const invalid of [
    syntheticIdentity({ comment: "personal-key" }),
    syntheticIdentity({ cipher: "aes256-ctr" }),
    syntheticIdentity({ mismatchChecks: true }),
    syntheticIdentity({ changeSeed: true }),
    syntheticIdentity().subarray(0, 128),
    Buffer.from(hostPublicKey),
  ]) {
    expect(() => validateWindowsPickerIdentity(invalid)).toThrow(/fixture-only comment/);
  }
});

it("restricts paths to the Rust owner's ordinary local disk path syntax", () => {
  expect(ordinaryWindowsPickerPath("C:\\Private Fixture\\fixture.json")).toBe(
    "C:/Private Fixture/fixture.json",
  );
  for (const name of [
    "fixture.json",
    "C:fixture.json",
    "\\\\?\\C:\\private\\fixture.json",
    "\\\\share\\folder\\fixture.json",
    "C:/private/../fixture.json",
    "C:/private//fixture.json",
    "C:/private./fixture.json",
    "C:/ leading/fixture.json",
    "C:/tmp/NUL.conf/fixture.json",
    "C:/tmp/COM1 .conf/fixture.json",
    "C:/tmp/file:stream/fixture.json",
    "C:/tmp/%USERPROFILE%/fixture.json",
    "C:/tmp/short~1/fixture.json",
    `C:/${"a".repeat(228)}`,
  ]) {
    expect(ordinaryWindowsPickerPath(name), name).toBeUndefined();
  }
});

it("allows only ancestor grants that cannot replace the private path; denies any foreign private grant", () => {
  expect(() => validateAcl(systemAncestor, privateEntry)).not.toThrow();
  expect(() =>
    validateAcl(
      { ...systemAncestor, rules: [...systemAncestor.rules, rule(users, 0x6)] },
      privateEntry,
    ),
  ).not.toThrow();
  expect(() =>
    validateAcl(
      { ...systemAncestor, rules: [...systemAncestor.rules, rule(users, 0x40000000, true)] },
      privateEntry,
    ),
  ).not.toThrow();
  for (const right of [0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000]) {
    expect(() =>
      validateAcl(
        { ...systemAncestor, rules: [...systemAncestor.rules, rule(users, right)] },
        privateEntry,
      ),
    ).toThrow(/private ACLs/);
  }
  expect(() =>
    validateAcl(systemAncestor, {
      ...privateEntry,
      rules: [...privateEntry.rules, rule(users, 0x80, true)],
    }),
  ).toThrow(/private ACLs/);
});

it("fails closed on foreign owners, missing inventories, malformed ACEs and unknown DACLs", () => {
  for (const entry of [
    { ...privateEntry, owner: admin },
    { owner: sid, rules: [] },
    { owner: sid, rules: [{ ...rule(sid), rights: "1234" }] },
    { owner: sid, rules: [{ ...rule(sid), allow: false }] },
    { owner: sid, rules: [rule(sid, 1, true)] },
    undefined,
  ]) {
    expect(() => validateAcl(systemAncestor, entry)).toThrow(/private ACLs/);
  }
  expect(() => validateAcl({ ...systemAncestor, owner: users }, privateEntry)).toThrow(
    /private ACLs/,
  );
  expect(() => validateWindowsPickerAcl([false, true], { sid, entries: [systemAncestor] })).toThrow(
    /private ACLs/,
  );
});

it.skipIf(process.platform === "win32")(
  "rejects the loader before probing any fixture on another platform",
  async () => {
    await expect(loadWindowsLoopbackPickerFixture("C:/private/fixture.json")).rejects.toThrow(
      /requires Windows/,
    );
  },
);

it("derives only fixed sibling files, rejecting implicit/ambient manifests before ACL probing", () => {
  expect(windowsPickerFixturePaths("C:\\Private Fixture\\fixture.json")).toEqual({
    root: "C:/Private Fixture",
    config: "C:/Private Fixture/fixture.json",
    identity: "C:/Private Fixture/identity",
    knownHosts: "C:/Private Fixture/known_hosts",
  });
  expect(() => windowsPickerFixturePaths("\\\\share\\fixture.json")).toThrow(/absolute ordinary/);
  expect(() => windowsPickerFixturePaths("C:/private/another.json")).toThrow(/absolute ordinary/);
  expect(() => windowsPickerFixturePaths("C:/fixture.json")).toThrow(/dedicated private directory/);
  expect(() => windowsPickerFixturePaths("C:/Users/demo/.SSH/picker/fixture.json")).toThrow(
    /outside \.ssh/,
  );
});
