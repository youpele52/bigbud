import { createHash, randomBytes } from "node:crypto";
import { win32 as path } from "node:path";
import { V2WindowsInspector, decodeInspectionHex } from "./SharedService.windows.ts";
import { decodeV2WindowsDirectoryIdentity } from "./SharedService.windows.identity.ts";
import { currentV2RequestContext } from "./Client.guard.ts";

export interface V2WindowsFileIdentity {
  readonly dev: string;
  readonly ino: string;
}
export interface V2WindowsFile {
  readonly identity: V2WindowsFileIdentity;
  readonly content: string;
  readonly hash: string;
}
export const v2WindowsFiles = new V2WindowsInspector(undefined, {
  request: 299_998,
  response: 2_100_002,
});
const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
export const windowsFileHash = (value: string) => createHash("sha256").update(value).digest("hex");
const encodeIdentity = (value: V2WindowsFileIdentity) =>
  decodeV2WindowsDirectoryIdentity([`${value.dev}:${value.ino}`]);
const identity = (value: string | undefined): V2WindowsFileIdentity => {
  const encoded = decodeV2WindowsDirectoryIdentity(value === undefined ? [] : [value]);
  return { dev: encoded.slice(0, 16), ino: encoded.slice(17) };
};

async function request(fields: readonly string[], issuance?: () => void) {
  const context = currentV2RequestContext();
  const capabilities = await v2WindowsFiles.request("CAPABILITIES\t1");
  if (!capabilities.includes("private-files=1"))
    throw new Error("V2 native private-file capability unavailable; rebuild the bigbud helper.");
  const physical = v2WindowsFiles.request(["FS", "1", ...fields].join("\t"), issuance);
  context?.observeOperation?.(physical);
  return await physical;
}

/** Full-width native identities, with same-handle ACL/reparse/ancestor validation on every operation. */
export async function windowsDirectory(
  directory: string,
  privateOnly: boolean,
  expected?: V2WindowsFileIdentity,
) {
  const result = await request([
    "DIR",
    hex(directory),
    privateOnly ? "private" : "public",
    expected ? encodeIdentity(expected) : "-",
  ]);
  if (result.length !== 1) throw new Error("V2 native directory reply rejected.");
  return identity(result[0]);
}

export async function windowsRead(
  filename: string,
  privateOnly: boolean,
  maxBytes = 131072,
): Promise<V2WindowsFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1048576)
    throw new Error("V2 native read bound rejected.");
  const result = await request([
    "READ",
    hex(path.dirname(filename)),
    "-",
    hex(path.basename(filename)),
    privateOnly ? "private" : "public",
    String(maxBytes),
  ]);
  if (result.length !== 3 || (!result[2] && result[2] !== "") || result[2]!.length > maxBytes * 2)
    throw new Error("V2 native read reply rejected.");
  const content = decodeInspectionHex(result[2]!);
  if (windowsFileHash(content) !== result[1]) throw new Error("V2 native read hash rejected.");
  return { identity: identity(result[0]), hash: result[1]!, content };
}

export async function windowsList(directory: string) {
  const result = await request(["LIST", hex(directory), "private", "-"]);
  identity(result[0]);
  if (result.length > 4097) throw new Error("V2 native inventory bound rejected.");
  return result.slice(1).map(decodeInspectionHex);
}

export async function windowsMkdir(
  parent: string,
  name: string,
  issuance: () => void,
  expected?: V2WindowsFileIdentity,
) {
  const parentIdentity = expected ?? (await windowsDirectory(parent, false));
  const result = await request(
    [
      "MKDIR",
      hex(parent),
      encodeIdentity(parentIdentity),
      hex(name),
      hex(`.directory.${randomBytes(16).toString("hex")}`),
    ],
    issuance,
  );
  if (result.length !== 1)
    throw new Error("V2 native directory creation acknowledgement uncertain.");
  return identity(result[0]);
}

/** Flush file bytes, then synchronous same-volume write-through rename; never POSIX directory fsync emulation. */
export async function windowsCreate(
  filename: string,
  content: string,
  issuance: () => void,
  expected?: V2WindowsFileIdentity,
) {
  if (Buffer.byteLength(content) > 131072)
    throw new Error("V2 native private-file write bound exceeded.");
  const parent = path.dirname(filename),
    parentIdentity = expected ?? (await windowsDirectory(parent, false));
  const result = await request(
    [
      "CREATE",
      hex(parent),
      encodeIdentity(parentIdentity),
      hex(path.basename(filename)),
      hex(`.write.${randomBytes(16).toString("hex")}`),
      hex(content),
    ],
    issuance,
  );
  if (result.length !== 2 || result[1] !== windowsFileHash(content))
    throw new Error("V2 native creation acknowledgement uncertain; evidence retained.");
  return { identity: identity(result[0]), hash: result[1], content };
}

export async function windowsPublish(
  staging: string,
  target: string,
  source: V2WindowsFile,
  previous: V2WindowsFile | undefined,
  parentIdentity: V2WindowsFileIdentity,
  issuance: () => void,
) {
  if (path.dirname(staging) !== path.dirname(target))
    throw new Error("V2 native publication must stay in one directory.");
  const result = await request(
    [
      "PUBLISH",
      hex(path.dirname(target)),
      encodeIdentity(parentIdentity),
      hex(path.basename(staging)),
      encodeIdentity(source.identity),
      source.hash,
      hex(path.basename(target)),
      previous ? encodeIdentity(previous.identity) : "-",
      previous?.hash ?? "-",
    ],
    issuance,
  );
  if (
    result.length !== 2 ||
    result[0] !== encodeIdentity(source.identity) ||
    result[1] !== source.hash
  )
    throw new Error("V2 native publication acknowledgement uncertain; evidence retained.");
}

/** Only exact owned finalizers call this; uncertain/foreign locks are never reclaimed. */
export async function windowsRemove(filename: string, owned: V2WindowsFile, issuance: () => void) {
  const parent = path.dirname(filename),
    parentIdentity = await windowsDirectory(parent, false);
  const result = await request(
    [
      "REMOVE",
      hex(parent),
      encodeIdentity(parentIdentity),
      hex(path.basename(filename)),
      encodeIdentity(owned.identity),
      owned.hash,
    ],
    issuance,
  );
  if (result.length) throw new Error("V2 native owned-file removal acknowledgement uncertain.");
}
