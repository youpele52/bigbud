import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import {
  assertPrivateWindowsPickerPaths,
  ordinaryWindowsPickerPath,
} from "./sshPicker.loopback.fixture.windows.acl.ts";

const loopback = "127.0.0.1";
const manifestName = "fixture.json";
const kind = "bigbud-windows-posix-picker-v1";
const keyComment = "bigbud-windows-picker-fixture";
const keyType = "ssh-ed25519";
const blobPrefix = Buffer.from("\0\0\0\x0bssh-ed25519\0\0\0\x20");
const keyMagic = Buffer.from("openssh-key-v1\0");
const ed25519SeedPrefix = Buffer.from("302e020100300506032b657004220420", "hex");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalidManifest(): never {
  throw new Error(
    "Invalid Windows picker fixture manifest: expected one disposable POSIX sshd on 127.0.0.1.",
  );
}

export function parseWindowsPickerFixtureManifest(bytes: Uint8Array) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decoder.decode(bytes));
  } catch {
    invalidManifest();
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) invalidManifest();
  const config = decoded as Record<string, unknown>;
  const { port, user, hostPublicKey } = config;
  if (
    Object.keys(config).length !== 5 ||
    config.kind !== kind ||
    config.host !== loopback ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof user !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(user) ||
    user.toLowerCase() === "root" ||
    typeof hostPublicKey !== "string"
  ) {
    invalidManifest();
  }
  const encoded = hostPublicKey.slice(keyType.length + 1);
  if (hostPublicKey !== `${keyType} ${encoded}` || !/^[A-Za-z0-9+/]{68}$/.test(encoded)) {
    invalidManifest();
  }
  const blob = Buffer.from(encoded, "base64");
  if (!blob.subarray(0, blobPrefix.length).equals(blobPrefix)) invalidManifest();
  const host = `[${loopback}]:${port}`;
  return {
    loopback,
    port,
    user,
    host,
    expectedFingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    pin: `${host} ${hostPublicKey}`,
  } as const;
}

export function validateWindowsPickerPin(bytes: Buffer, pin: string) {
  if (
    bytes.length &&
    !bytes.equals(Buffer.from(`${pin}\n`)) &&
    !bytes.equals(Buffer.from(`${pin}\r\n`))
  ) {
    throw new Error(
      "The Windows picker fixture pin must be empty or contain only its configured host key.",
    );
  }
}

class WireReader {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  uint32() {
    return this.take(4).readUInt32BE(0);
  }

  take(length: number) {
    if (length > this.bytes.length - this.offset) throw new Error("Truncated key.");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  field() {
    return this.take(this.uint32());
  }

  rest() {
    return this.take(this.bytes.length - this.offset);
  }
}

/** Verify the fixture-only marker inside the private key, not a mutable sibling .pub file. */
export function validateWindowsPickerIdentity(bytes: Buffer) {
  try {
    const content = decoder.decode(bytes);
    const match =
      /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END OPENSSH PRIVATE KEY-----\r?\n?$/.exec(
        content,
      );
    if (!match) throw new Error();
    const encoded = match[1]!.replace(/\r?\n/g, "");
    const binary = Buffer.from(encoded, "base64");
    if (binary.toString("base64") !== encoded) throw new Error();
    const outer = new WireReader(binary);
    if (
      !outer.take(keyMagic.length).equals(keyMagic) ||
      !outer.field().equals(Buffer.from("none")) ||
      !outer.field().equals(Buffer.from("none")) ||
      outer.field().length !== 0 ||
      outer.uint32() !== 1
    ) {
      throw new Error();
    }
    const publicBlob = outer.field();
    const privateBlob = outer.field();
    if (outer.rest().length || privateBlob.length % 8 !== 0) throw new Error();
    const inner = new WireReader(privateBlob);
    if (inner.uint32() !== inner.uint32() || !inner.field().equals(Buffer.from(keyType))) {
      throw new Error();
    }
    const publicKey = inner.field();
    const privateKey = inner.field();
    if (
      publicKey.length !== 32 ||
      !publicBlob.equals(Buffer.concat([blobPrefix, publicKey])) ||
      privateKey.length !== 64 ||
      !privateKey.subarray(32).equals(publicKey) ||
      !inner.field().equals(Buffer.from(keyComment))
    ) {
      throw new Error();
    }
    const padding = inner.rest();
    if (padding.length > 7 || !padding.every((byte, index) => byte === index + 1))
      throw new Error();
    const seed = createPrivateKey({
      key: Buffer.concat([ed25519SeedPrefix, privateKey.subarray(0, 32)]),
      format: "der",
      type: "pkcs8",
    });
    const derived = createPublicKey(seed).export({ format: "jwk" });
    if (derived.x !== publicKey.toString("base64url")) throw new Error();
  } catch {
    throw new Error(
      "The Windows picker identity must be a fresh unencrypted Ed25519 fixture key with its fixture-only comment.",
    );
  }
}

async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit)
      throw new Error("Invalid fixture file.");
    const data = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) return data.subarray(0, offset);
      offset += bytesRead;
    }
    throw new Error("Invalid fixture file size.");
  } finally {
    await handle.close();
  }
}

async function rejectIdentitySidecars(identity: string) {
  // OpenSSH can look for companion public keys/certificates beside an explicit identity.
  for (const suffix of [".pub", "-cert", "-cert.pub"]) {
    try {
      await lstat(`${identity}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Could not establish that the Windows picker identity has no sidecars.", {
        cause: error,
      });
    }
    throw new Error(
      "Do not place public-key or certificate sidecars beside the Windows picker identity.",
    );
  }
}

export function windowsPickerFixturePaths(configFile: string) {
  const config = ordinaryWindowsPickerPath(configFile);
  if (!config || path.win32.basename(config) !== manifestName) {
    throw new Error("An absolute ordinary Windows path to the private fixture.json is required.");
  }
  const root = path.win32.dirname(config).replaceAll("\\", "/");
  const identity = ordinaryWindowsPickerPath(`${root}/identity`);
  const knownHosts = ordinaryWindowsPickerPath(`${root}/known_hosts`);
  if (!identity || !knownHosts || root.toLowerCase().split("/").includes(".ssh")) {
    throw new Error(
      "The Windows picker fixture requires a dedicated private directory outside .ssh.",
    );
  }
  return { root, config, identity, knownHosts };
}

/** Bind only an operator-provided fixture. No SSH, target discovery, provisioning or cleanup. */
export async function loadWindowsLoopbackPickerFixture(configFile: string) {
  if (process.platform !== "win32")
    throw new Error("The pre-provisioned picker fixture requires Windows.");
  const { root, config, identity, knownHosts } = windowsPickerFixturePaths(configFile);
  await assertPrivateWindowsPickerPaths(root, [config, identity, knownHosts]);
  await rejectIdentitySidecars(identity);
  const { pin, ...binding } = parseWindowsPickerFixtureManifest(await readBounded(config, 4_096));
  validateWindowsPickerPin(await readBounded(knownHosts, 128), pin);
  validateWindowsPickerIdentity(await readBounded(identity, 4_096));

  // The UI target ID is a label, not a second way to pass credential paths or SSH options.
  const target = new URLSearchParams({
    host: loopback,
    port: String(binding.port),
    user: binding.user,
  });
  return { ...binding, root, identity, knownHosts, executionTargetId: `ssh:${target}` } as const;
}
