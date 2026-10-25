/** Native execution acknowledgement and managed file-write acknowledgement have different scopes. */
export function hasOpencodeV2NativeTrust(value: {
  readonly nativeServiceTrust?: string | null | undefined;
}) {
  return (
    value.nativeServiceTrust === "host-user-v1" ||
    value.nativeServiceTrust === "managed-thread-tools-v2"
  );
}

/** Enabling a provider or loading an old acknowledgement never authorizes required-plugin installation. */
export function hasOpencodeV2ManagedPluginTrust(value: {
  readonly nativeServiceTrust?: string | null | undefined;
}) {
  return value.nativeServiceTrust === "managed-thread-tools-v2";
}
