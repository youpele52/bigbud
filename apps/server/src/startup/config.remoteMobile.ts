import { Redacted } from "effect";
import { RemoteProfileConfigurationError } from "./config.remote.ts";

export interface RemoteMobileConfiguration {
  readonly gatewayCredential: Redacted.Redacted<string>;
}

/** Explicit remote extension consent is separate from per-session mobile authorization. */
export function resolveRemoteMobileConfiguration(input: {
  readonly mode: string;
  readonly enabled: boolean;
  readonly gatewayCredential: string | undefined;
  readonly clientToken: string | undefined;
}): RemoteMobileConfiguration | undefined {
  if (!input.enabled) return undefined;
  if (input.mode !== "remote")
    throw new RemoteProfileConfigurationError(
      "The remote mobile extension requires remote backend mode.",
    );
  const credential = input.gatewayCredential;
  if (
    credential === undefined ||
    credential.length < 32 ||
    credential.length > 256 ||
    /[^\x21-\x7e]/.test(credential) ||
    credential === input.clientToken
  )
    throw new RemoteProfileConfigurationError(
      "The remote mobile extension requires a separate gateway credential of 32–256 visible ASCII characters.",
    );
  return { gatewayCredential: Redacted.make(credential) };
}
