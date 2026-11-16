import * as fs from "node:fs";
import { join } from "node:path";
import { Schema, Redacted } from "effect";
import type { BackendInstanceShape } from "../startup/backendInstance.ts";
import type { ServerConfigShape } from "../startup/config.ts";
import { MobileGatewayConfiguration } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { resolveRemoteMobileConfiguration } from "../startup/config.remoteMobile.ts";

export const MobileGatewayProcessInput = Schema.Struct({
  nonce: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/)),
  ...MobileGatewayConfiguration.fields,
});
export type MobileGatewayProcessInput = typeof MobileGatewayProcessInput.Type;
function socketStamp(path: string): string {
  const info = fs.lstatSync(path, { bigint: true });
  if (
    !info.isSocket() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (info.mode & 0o7777n) !== 0o600n ||
    info.nlink !== 1n ||
    fs.realpathSync(path) !== path
  )
    throw Error("Mobile process requires the fixed sealed private Unix socket.");
  return [info.dev, info.ino, info.uid, info.mode].join(":");
}
export function mobileGatewayProcessConfiguration(
  owner: BackendInstanceShape,
  config: ServerConfigShape,
  input: unknown,
) {
  const selected = Object.freeze(
    Schema.decodeUnknownSync(MobileGatewayProcessInput)(input, { onExcessProperty: "error" }),
  );
  if (
    process.platform !== "linux" ||
    config.mode !== "remote" ||
    config.stateDir !== owner.stateDir ||
    !config.remoteMobile
  )
    throw Error("Mobile process requires its existing configured private remote HTTP surface.");
  const mobile = resolveRemoteMobileConfiguration({
    mode: config.mode,
    enabled: true,
    gatewayCredential: Redacted.value(config.remoteMobile.gatewayCredential),
    clientToken: config.authToken,
  });
  if (!mobile) throw Error("Separate private mobile credential unavailable.");
  const path = join(owner.stateDir, "remote-mobile.sock");
  if (Buffer.byteLength(path) >= 108) throw Error("Private mobile socket exceeds Unix path bound.");
  return Object.freeze({
    selected,
    upstream: Object.freeze({ kind: "unix" as const, path }),
    credential: Redacted.value(mobile.gatewayCredential),
  });
}
export function captureSealedMobileGatewaySocket(path: string) {
  const expected = socketStamp(path);
  return () => {
    if (socketStamp(path) !== expected)
      throw Error("Sealed mobile socket changed; preserve ownership.");
  };
}
