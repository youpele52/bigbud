import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";
/** Private account-service projection. Rust remains authoritative for artifact and unit validation. */
export const LOCAL_SUPERVISOR_SERVICE_CONFIG_KEYS = [
  "version",
  "authority",
  "home",
  "backend_home",
  "rust_binary",
  "rust_sha256",
  "rust_state",
  "node_binary",
  "node_sha256",
  "backend_entry",
  "backend_sha256",
  "receipt_sha256",
  "restart",
  "launch_attempt",
  "prior_epoch",
  "launch_boot",
  "expected_installation_fingerprint",
  "authority_reservation_sha256",
] as const;
export type LocalSupervisorServiceConfigKey = (typeof LOCAL_SUPERVISOR_SERVICE_CONFIG_KEYS)[number];
export type LocalSupervisorServiceConfig = Readonly<
  Record<LocalSupervisorServiceConfigKey, string>
>;
const keys = new Set<string>(LOCAL_SUPERVISOR_SERVICE_CONFIG_KEYS);

export function decodeLocalSupervisorServiceConfig(text: string): LocalSupervisorServiceConfig {
  if (Buffer.byteLength(text) > 32 * 1024) throw new Error("Service config is oversized.");
  const values = new Map<string, string>();
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      separator <= 0 ||
      !keys.has(key) ||
      values.has(key) ||
      !value ||
      hasLocalSupervisorServiceControls(value)
    )
      throw new Error("Service config contains invalid or duplicate fields.");
    values.set(key, value);
  }
  if (
    values.size !== keys.size ||
    values.get("version") !== "1" ||
    !/^[a-f0-9]{32}$/.test(values.get("authority") ?? "") ||
    [
      "rust_sha256",
      "node_sha256",
      "backend_sha256",
      "receipt_sha256",
      "authority_reservation_sha256",
    ].some((key) => !/^[a-f0-9]{64}$/.test(values.get(key) ?? "")) ||
    !/^sha256:[a-f0-9]{64}$/.test(values.get("expected_installation_fingerprint") ?? "") ||
    !["yes", "no"].includes(values.get("restart") ?? "")
  )
    throw new Error("Service config has an unsupported version or artifact identity.");
  return Object.freeze(
    Object.fromEntries(
      LOCAL_SUPERVISOR_SERVICE_CONFIG_KEYS.map((key) => [key, values.get(key)!]),
    ) as Record<LocalSupervisorServiceConfigKey, string>,
  );
}

export function encodeLocalSupervisorServiceConfig(config: LocalSupervisorServiceConfig): string {
  const encoded = LOCAL_SUPERVISOR_SERVICE_CONFIG_KEYS.map((key) => `${key}=${config[key]}\n`).join(
    "",
  );
  decodeLocalSupervisorServiceConfig(encoded);
  return encoded;
}
