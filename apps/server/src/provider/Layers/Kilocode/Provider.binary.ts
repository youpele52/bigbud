import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** Resolve the default KiloCode binary installed by the curl installer. */
export function resolveKilocodeBinary(binaryPath: string): string {
  if (binaryPath !== "kilo") return binaryPath;
  const curlPath = `${homedir()}/.kilo/bin/kilo`;
  try {
    if (existsSync(curlPath)) return curlPath;
  } catch {
    // Fall through to PATH lookup.
  }
  return binaryPath;
}
