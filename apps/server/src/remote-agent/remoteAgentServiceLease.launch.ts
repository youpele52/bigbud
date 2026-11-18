import { createHash } from "node:crypto";
import type { RemoteAgentServiceLeaseStart } from "./remoteAgentProtocol.serviceLease.ts";

/** Only serialized launch fields; capability and the resulting digest are not hash inputs. */
export type NativeLeaseLaunchFingerprintInput = Pick<
  RemoteAgentServiceLeaseStart,
  | "executable"
  | "args"
  | "environment"
  | "guard"
  | "assetsGeneration"
  | "assetsReceiptSize"
  | "assetsReceiptSha256"
  | "assetsArgument"
> & {
  readonly binding:
    | Pick<NonNullable<RemoteAgentServiceLeaseStart["binding"]>, "executableSha256">
    | undefined;
};

/** Mirrors the native private monitor frame; no filesystem IO or implicit authority. */
export function nativeLeaseLaunchFingerprint(
  stateDir: string,
  input: NativeLeaseLaunchFingerprintInput,
): Uint8Array {
  const parts: Buffer[] = [];
  let size = 0;
  const field = (value: Uint8Array | string) => {
    const lengthBytes =
      typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
    if (lengthBytes > 65536) throw Error("Native lease bootstrap field exceeds its bound.");
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    if ((size += bytes.length + 4) > 128 * 1024)
      throw Error("Native lease bootstrap exceeds its bound.");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  };
  const number = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    parts.push(bytes);
    size += 4;
  };
  if (
    !stateDir.startsWith("/") ||
    stateDir.includes("\0") ||
    stateDir.split("/").some((part) => part === "." || part === "..") ||
    stateDir.includes("//")
  )
    throw Error("Invalid original native state directory.");
  if (
    !input.binding ||
    input.args.length > 128 ||
    input.environment.length > 64 ||
    input.assetsReceiptSha256.length !== 32 ||
    !Number.isSafeInteger(input.assetsReceiptSize) ||
    input.assetsReceiptSize < 1 ||
    input.assetsReceiptSize > 8 * 1024 * 1024
  )
    throw Error("Invalid native lease launch shape.");
  field("bigbud-service-lease=1");
  field(input.binding.executableSha256);
  field(input.executable);
  number(input.args.length);
  for (const value of input.args) field(value);
  number(input.environment.length);
  for (const value of input.environment) {
    field(value.name);
    field(value.value);
  }
  field(input.guard);
  field(stateDir);
  field(input.assetsGeneration);
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(input.assetsReceiptSize));
  field(bytes);
  field(input.assetsReceiptSha256);
  field(input.assetsArgument);
  if (size > 128 * 1024) throw Error("Native lease bootstrap exceeds its bound.");
  return createHash("sha256").update(Buffer.concat(parts)).digest();
}
