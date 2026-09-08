import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLIENT_HELLO_FRAME = Buffer.from(
  "000000290a27080110021a08636c69656e742d31220c636f6e6e656374696f6e2d312a056e6f6e636530808040",
  "hex",
);

export async function verifyWorkspaceAgentHandshake(binaryPath: string): Promise<void> {
  await verifyMode(binaryPath, ["--ephemeral"], "workspace.watch", "resource.cleanup");
  await verifyMode(binaryPath, ["--resource-cleanup"], "resource.cleanup", "workspace.watch");
}

export async function verifyWorkspaceAgentCleanupSmoke(binaryPath: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "bigbud-packaged-cleanup-"));
  const target = join(root, "target");
  writeFileSync(target, "cleanup-smoke");
  const rootIdentity = cleanupIdentity(root);
  const targetIdentity = cleanupIdentity(target);
  const child = spawn(binaryPath, ["--resource-cleanup"], { stdio: ["pipe", "pipe", "pipe"] });
  const readFrame = framedReader(child);
  try {
    child.stdin.write(CLIENT_HELLO_FRAME);
    const hello = await readFrame();
    if (!hello.includes(Buffer.from("resource.cleanup"))) {
      throw new Error("packaged cleanup smoke did not negotiate resource.cleanup");
    }
    const platform =
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : process.platform;
    child.stdin.write(
      cleanupFrame(
        100,
        message([
          stringField(1, "packaged-smoke-root"),
          stringField(2, platform),
          bytesField(
            3,
            message([
              stringField(1, "0"),
              stringField(2, root),
              bytesField(3, identityMessage(rootIdentity)),
            ]),
          ),
        ]),
      ),
    );
    const bootstrap = await readFrame();
    if (!bootstrap.includes(Buffer.from("root-0"))) {
      throw new Error("packaged cleanup smoke root bootstrap failed");
    }
    const resource = message([
      stringField(1, "target"),
      stringField(2, "root-0"),
      stringField(3, "target"),
      stringField(4, ".bigbud-cleanup-packaged-smoke"),
      bytesField(5, identityMessage(targetIdentity)),
      bytesField(6, identityMessage(rootIdentity)),
      bytesField(7, identityMessage(rootIdentity)),
      uintField(8, 1),
    ]);
    const requestId = "packaged-smoke-cleanup";
    const operationId = "packaged-smoke-operation";
    const deadlineUnixMs = Date.now() + 10_000;
    const planDigest = Buffer.alloc(32, 2);
    const proofDigest = Buffer.alloc(32, 3);
    const pageDigest = cleanupPageDigest({
      resourceId: "target",
      rootHandle: "root-0",
      relativePath: "target",
      quarantineName: ".bigbud-cleanup-packaged-smoke",
      identity: targetIdentity,
      rootIdentity,
      parentIdentity: rootIdentity,
    });
    child.stdin.write(
      cleanupFrame(
        102,
        message([
          stringField(1, requestId),
          stringField(2, operationId),
          bytesField(3, pageDigest),
          uintField(4, deadlineUnixMs),
          stringField(5, platform),
          bytesField(6, resource),
          bytesField(7, planDigest),
          bytesField(8, proofDigest),
          bytesField(
            9,
            cleanupAuthorization({
              requestId,
              operationId,
              planDigest,
              pageDigest,
              proofDigest,
              deadlineUnixMs,
              platform,
            }),
          ),
        ]),
      ),
    );
    const response = await readFrame();
    if (!response.includes(Buffer.from("target")) || existsSync(target)) {
      throw new Error("packaged cleanup smoke did not remove the verified target");
    }
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
}

function cleanupIdentity(path: string): {
  readonly device: string;
  readonly inode: string;
  readonly type: number;
} {
  const stat = statSync(path, { bigint: true });
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    type: stat.isDirectory() ? 2 : 1,
  };
}

function varint(value: number): Buffer {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function message(fields: ReadonlyArray<Buffer>): Buffer {
  return Buffer.concat(fields);
}

function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

function stringField(field: number, value: string): Buffer {
  return bytesField(field, Buffer.from(value));
}

function uintField(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function identityMessage(identity: ReturnType<typeof cleanupIdentity>): Buffer {
  return message([
    stringField(1, identity.device),
    stringField(2, identity.inode),
    uintField(3, identity.type),
  ]);
}

function digestString(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length).update(bytes);
}

function digestIdentity(
  hash: ReturnType<typeof createHash>,
  identity: ReturnType<typeof cleanupIdentity> | undefined,
): void {
  hash.update(Buffer.from([identity ? 1 : 0]));
  if (!identity) return;
  digestString(hash, identity.device);
  digestString(hash, identity.inode);
  hash.update(Buffer.from([identity.type]));
}

export function cleanupPageDigest(input: {
  readonly resourceId: string;
  readonly rootHandle: string;
  readonly relativePath: string;
  readonly quarantineName: string;
  readonly identity?: ReturnType<typeof cleanupIdentity>;
  readonly rootIdentity: ReturnType<typeof cleanupIdentity>;
  readonly parentIdentity: ReturnType<typeof cleanupIdentity>;
}): Buffer {
  const hash = createHash("sha256").update("bigbud.resource-cleanup.page.v1\0");
  digestString(hash, input.resourceId);
  digestString(hash, input.rootHandle);
  digestString(hash, input.relativePath);
  digestString(hash, input.quarantineName);
  digestIdentity(hash, input.identity);
  digestIdentity(hash, input.rootIdentity);
  digestIdentity(hash, input.parentIdentity);
  return hash.update(Buffer.from([1])).digest();
}

export function cleanupAuthorization(input: {
  readonly requestId: string;
  readonly operationId: string;
  readonly planDigest: Buffer;
  readonly pageDigest: Buffer;
  readonly proofDigest: Buffer;
  readonly deadlineUnixMs: number;
  readonly platform: string;
}): Buffer {
  const hash = createHash("sha256").update("bigbud.resource-cleanup.authorization.v1\0");
  digestString(hash, input.requestId);
  digestString(hash, input.operationId);
  hash.update(input.planDigest).update(input.pageDigest).update(input.proofDigest);
  const deadline = Buffer.alloc(8);
  deadline.writeBigUInt64BE(BigInt(input.deadlineUnixMs));
  hash.update(deadline);
  digestString(hash, input.platform);
  return hash.digest();
}

function cleanupFrame(field: number, payload: Buffer): Buffer {
  const encoded = bytesField(field, payload);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([length, encoded]);
}

function framedReader(child: ReturnType<typeof spawn>): () => Promise<Buffer> {
  let buffered = Buffer.alloc(0);
  const frames: Buffer[] = [];
  const waiting: Array<(value: Buffer) => void> = [];
  child.stdout!.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4 && buffered.length >= buffered.readUInt32BE(0) + 4) {
      const length = buffered.readUInt32BE(0);
      const frame = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      const receiver = waiting.shift();
      if (receiver) receiver(frame);
      else frames.push(frame);
    }
  });
  return () =>
    new Promise<Buffer>((resolve, reject) => {
      const available = frames.shift();
      if (available) {
        resolve(available);
        return;
      }
      const timeout = setTimeout(() => reject(new Error("cleanup smoke frame timed out")), 5_000);
      waiting.push((frame) => {
        clearTimeout(timeout);
        resolve(frame);
      });
    });
}

async function verifyMode(
  binaryPath: string,
  args: ReadonlyArray<string>,
  requiredCapability: string,
  forbiddenCapability: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error(`handshake timed out: ${stderr.trim()}`)),
      5_000,
    );
    child.once("error", finish);
    child.stdin.on("error", () => {
      // The child may close stdin while the verifier is terminating it.
    });
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`agent exited (code=${code}, signal=${signal})`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length < 4) return;
      const length = stdout.readUInt32BE(0);
      if (stdout.length < length + 4) return;
      const payload = stdout.subarray(4, length + 4);
      if (
        payload[0] !== 0x12 ||
        !payload.includes(Buffer.from(requiredCapability)) ||
        payload.includes(Buffer.from(forbiddenCapability))
      ) {
        finish(new Error(`agent hello has an invalid ${requiredCapability} authority profile`));
        return;
      }
      finish();
    });
    child.stdin.write(CLIENT_HELLO_FRAME);
  });
}
