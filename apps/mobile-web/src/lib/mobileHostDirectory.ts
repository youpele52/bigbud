import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake";
import * as Schema from "effect/Schema";
import { canonicalMobileHostOrigin } from "./mobileHostSessions.logic";

export const MOBILE_HOST_DIRECTORY_STORAGE_KEY = "bigbud:mobile-web:host-directory:v1";
export interface MobileHostDirectoryEntry {
  readonly backendOrigin: string;
  readonly displayName?: string;
  readonly authorityId?: string;
}
const MAX_HOST_LINKS = 32;
function decodeEntry(raw: unknown): MobileHostDirectoryEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (
    Object.keys(raw).some((key) => !["backendOrigin", "displayName", "authorityId"].includes(key))
  )
    return null;
  if (
    !("backendOrigin" in raw) ||
    typeof raw.backendOrigin !== "string" ||
    canonicalMobileHostOrigin(raw.backendOrigin) !== raw.backendOrigin
  )
    return null;
  const name = "displayName" in raw ? raw.displayName : undefined;
  if (
    name !== undefined &&
    (typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      Array.from(name).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    return null;
  const authority = "authorityId" in raw ? raw.authorityId : undefined;
  try {
    return {
      backendOrigin: raw.backendOrigin,
      ...(typeof name === "string" ? { displayName: name.trim() } : {}),
      ...(authority === undefined
        ? {}
        : { authorityId: Schema.decodeUnknownSync(RemoteBackendAuthorityId)(authority) }),
    };
  } catch {
    return null;
  }
}
type DirectoryStorage = Pick<Storage, "getItem" | "setItem">;
export function readMobileHostDirectory(
  storage: Pick<Storage, "getItem">,
):
  | { readonly ok: true; readonly entries: ReadonlyArray<MobileHostDirectoryEntry> }
  | { readonly ok: false } {
  try {
    const raw = storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY);
    if (raw === null) return { ok: true, entries: [] };
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("version" in value) ||
      value.version !== 1 ||
      !("entries" in value) ||
      !Array.isArray(value.entries) ||
      value.entries.length > MAX_HOST_LINKS ||
      Object.keys(value).some((key) => !["version", "entries"].includes(key))
    )
      return { ok: false };
    const entries: MobileHostDirectoryEntry[] = [];
    for (const candidate of value.entries) {
      const entry = decodeEntry(candidate);
      if (!entry || entries.some((saved) => saved.backendOrigin === entry.backendOrigin))
        return { ok: false };
      entries.push(entry);
    }
    return { ok: true, entries };
  } catch {
    return { ok: false };
  }
}

/** Only explicit public fields can be written. Unknown/credential-bearing raw data is preserved. */
export function writeMobileHostDirectory(
  storage: DirectoryStorage,
  entries: ReadonlyArray<MobileHostDirectoryEntry>,
): boolean {
  if (entries.length > MAX_HOST_LINKS) return false;
  const decoded = entries.map(decodeEntry);
  if (decoded.some((entry) => !entry)) return false;
  const valid = decoded.filter((entry): entry is MobileHostDirectoryEntry => entry !== null);
  if (new Set(valid.map((entry) => entry.backendOrigin)).size !== valid.length) return false;
  try {
    if (!readMobileHostDirectory(storage).ok) return false;
    const raw = JSON.stringify({ version: 1, entries: valid });
    storage.setItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY, raw);
    return storage.getItem(MOBILE_HOST_DIRECTORY_STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}
