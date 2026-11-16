import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  parseStateDirLockRecord,
  STATE_DIR_LOCK_FILENAME,
} from "@bigbud/shared/backendOwnership.record";
import { LocalNativeInspection, decodeInspectionHex } from "./localNativeInspection.ts";

export async function readWindowsControlIdentity(socketPath: string, serving = false) {
  const filename = join(dirname(dirname(socketPath)), STATE_DIR_LOCK_FILENAME);
  const inspector = new LocalNativeInspection();
  try {
    const fields = await inspector.request(`READ\t${Buffer.from(filename).toString("hex")}`);
    if (fields.length !== 1 || fields[0]!.length > 16_384)
      throw new Error("Backend identity bound.");
    const raw = decodeInspectionHex(fields[0]!);
    const record = parseStateDirLockRecord(raw);
    if (!record || !/^[a-f0-9]{32}$/.test(record.nonce) || (serving && record.pid !== process.pid))
      throw new Error("Backend identity unavailable.");
    // Public generation identity excludes the existing backend shutdown secret and control port.
    const backend = createHash("sha256")
      .update(JSON.stringify([record.format, record.pid, record.startedAt, record.nonce]))
      .digest("hex");
    // Volatile integrity proof only: never persisted, logged, or used as pipe authentication.
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    return { filename, backend, fingerprint };
  } finally {
    inspector.close();
  }
}
