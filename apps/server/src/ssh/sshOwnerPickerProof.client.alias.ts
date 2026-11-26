import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofAliasConfig {
  readonly file: string;
  readonly alias: string;
  readonly systemFile?: string;
  /** Authority from the trusted fixture launcher, not from config or an RPC. */
  readonly localAccount?: { readonly uid: number; readonly name: string };
  /** Only explicitly selected fields; never copy the resolved route into this object. */
  readonly overrides?: { readonly host?: string; readonly user?: string; readonly port?: number };
  /** macOS fixture only: approved connector image digest and absolute PATH, in order. */
  readonly connector?: { readonly imageSha256: string; readonly path: readonly string[] };
}

const safePath = (value: string) => isAbsolute(value) && !value.includes("\0");
const login = /^[A-Za-z0-9_.-]{1,64}$/;

export function proofAliasStartupArgs(config: PickerProofAliasConfig | undefined): string[] {
  if (!config) return [];
  const { file, alias, systemFile, localAccount, overrides, connector } = config;
  if (
    !safePath(file) ||
    !alias ||
    alias.includes("\0") ||
    (systemFile !== undefined && !safePath(systemFile))
  )
    throw new PickerProofOwnerError("invalidOperands");
  if (
    ((localAccount || overrides) && process.platform !== "darwin") ||
    (connector && process.platform !== "darwin" && process.platform !== "linux")
  )
    throw new PickerProofOwnerError("invalidOperands");
  const args = [file, alias];
  if (systemFile) args.push("--system-config", systemFile);
  if (localAccount) {
    if (
      !Number.isInteger(localAccount.uid) ||
      localAccount.uid < 1 ||
      localAccount.uid > 0xffffffff ||
      !login.test(localAccount.name)
    )
      throw new PickerProofOwnerError("invalidOperands");
    args.push("--fixture-local-account", String(localAccount.uid), localAccount.name);
  }
  if (overrides) {
    const { host, user, port } = overrides;
    if (
      Object.keys(overrides).some((key) => !["host", "user", "port"].includes(key)) ||
      (host !== undefined && !isIP(host)) ||
      (user !== undefined && !login.test(user)) ||
      (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    )
      throw new PickerProofOwnerError("invalidOperands");
    if (host !== undefined) args.push("--fixture-override-host", host);
    if (user !== undefined) args.push("--fixture-override-user", user);
    if (port !== undefined) args.push("--fixture-override-port", String(port));
  }
  if (connector) {
    const { imageSha256, path } = connector;
    if (
      !/^[0-9a-f]{64}$/.test(imageSha256) ||
      path.length < 1 ||
      path.length > 4 ||
      !path.every(safePath)
    )
      throw new PickerProofOwnerError("invalidOperands");
    args.push("--posix-connector-picker", "--fixture-connector-image", imageSha256);
    for (const entry of path) args.push("--fixture-connector-path", entry);
  }
  return args;
}
