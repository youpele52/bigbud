import { createHash } from "node:crypto";

/** Linux identities are new and lossless; macOS must retain its exact historical number serialization. */
export function v2UnixStorageIdentity(
  platform: "darwin" | "linux",
  databasePath: string,
  metadata: { dev: number | bigint; ino: number | bigint },
): string {
  const fields =
    platform === "darwin"
      ? ["opencodeV2-shared-local", databasePath, metadata.dev, metadata.ino]
      : [
          "opencodeV2-shared-linux-v1",
          databasePath,
          metadata.dev.toString(),
          metadata.ino.toString(),
        ];
  if (
    typeof metadata.dev !== (platform === "darwin" ? "number" : "bigint") ||
    typeof metadata.ino !== typeof metadata.dev
  )
    throw new Error("Native storage identity precision unavailable.");
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
