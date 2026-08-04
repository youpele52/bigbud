import { createHash } from "node:crypto";

import { Schema } from "effect";

import { PurgeResourceManifest } from "./Services/PurgeJobRepository.ts";

export function purgeManifestDigest(manifest: unknown): string {
  const normalized = Schema.decodeUnknownSync(PurgeResourceManifest)(manifest);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
