import { Schema } from "effect";

export const remoteAgentConnectionWarningFields = {
  warning: Schema.optional(Schema.String),
  requestedVersion: Schema.optional(Schema.String),
};

export function validateRemoteAgentConnectionWarning(entry: {
  readonly warning?: string | undefined;
  readonly requestedVersion?: string | undefined;
}): void {
  if (
    entry.warning !== undefined &&
    (!entry.warning.trim() || entry.warning.length > 512 || /[\r\n]/.test(entry.warning))
  )
    throw new Error("Invalid registry connection warning.");
  if (
    entry.requestedVersion !== undefined &&
    (!entry.requestedVersion ||
      entry.requestedVersion.length > 128 ||
      !/^[\x21-\x7e]+$/.test(entry.requestedVersion))
  )
    throw new Error("Invalid registry requested version.");
}
