import { decodeMessage } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";

import {
  boolValue,
  bytesValue,
  invalid,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/** Must match the Rust `config::aliases` and the protocol comments. */
export const MAX_ALIAS_ENTRIES = 256;
export const MAX_ALIAS_METADATA = 255;

export type PickerProofAliasRouteKind = "direct" | "restrictedConnector" | "jump";

export interface PickerProofAliasUnsupported {
  readonly reason: string;
  readonly remedy: string;
  readonly source: string;
  readonly line: number;
}

export interface PickerProofAliasEntry {
  readonly alias: string;
  readonly hostName: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyAlias: string;
  readonly routeKind: PickerProofAliasRouteKind;
  readonly jumpHops: number;
  readonly source: string;
  readonly line: number;
  readonly unsupported?: PickerProofAliasUnsupported;
}

export interface PickerProofAliasList {
  readonly entries: ReadonlyArray<PickerProofAliasEntry>;
  readonly truncated: boolean;
  readonly maxEntries: number;
}

const routeKinds: Record<number, PickerProofAliasRouteKind> = {
  1: "direct",
  2: "restrictedConnector",
  3: "jump",
};

const bounded = (value: string) => value.length <= MAX_ALIAS_METADATA;

function readUnsupported(bytes: Uint8Array): PickerProofAliasUnsupported {
  let reason = "";
  let remedy = "";
  let source = "";
  let line: number | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) reason = stringValue(wire, reader);
    else if (field === 2) remedy = stringValue(wire, reader);
    else if (field === 3) source = stringValue(wire, reader);
    else if (field === 4) {
      if (line !== undefined) return invalid();
      line = uintValue(wire, reader);
    } else reader.skip(wire);
  });
  if (
    !reason ||
    !remedy ||
    !source ||
    !bounded(reason) ||
    !bounded(remedy) ||
    !bounded(source) ||
    line === undefined
  )
    return invalid();
  return { reason, remedy, source, line };
}

function readEntry(bytes: Uint8Array): PickerProofAliasEntry {
  let alias = "";
  let hostName = "";
  let port: number | undefined;
  let user = "";
  let hostKeyAlias = "";
  let routeKind: PickerProofAliasRouteKind | undefined;
  let jumpHops = 0;
  let source = "";
  let line: number | undefined;
  let unsupported: PickerProofAliasUnsupported | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) alias = stringValue(wire, reader);
    else if (field === 2) hostName = stringValue(wire, reader);
    else if (field === 3) {
      if (port !== undefined) return invalid();
      port = uintValue(wire, reader);
    } else if (field === 4) user = stringValue(wire, reader);
    else if (field === 5) hostKeyAlias = stringValue(wire, reader);
    else if (field === 6) {
      if (routeKind !== undefined) return invalid();
      routeKind = routeKinds[uintValue(wire, reader)];
      if (routeKind === undefined) return invalid();
    } else if (field === 7) {
      if (jumpHops !== 0) return invalid();
      jumpHops = uintValue(wire, reader);
    } else if (field === 8) source = stringValue(wire, reader);
    else if (field === 9) {
      if (line !== undefined) return invalid();
      line = uintValue(wire, reader);
    } else if (field === 10) {
      if (unsupported !== undefined) return invalid();
      unsupported = readUnsupported(bytesValue(wire, reader));
    } else reader.skip(wire);
  });
  if (
    !alias ||
    !hostName ||
    !source ||
    !bounded(alias) ||
    !bounded(hostName) ||
    !bounded(user) ||
    !bounded(hostKeyAlias) ||
    !bounded(source) ||
    port === undefined ||
    port < 1 ||
    port > 65_535 ||
    routeKind === undefined ||
    line === undefined ||
    (routeKind === "jump") !== jumpHops > 0
  )
    return invalid();
  return {
    alias,
    hostName,
    port,
    user,
    hostKeyAlias,
    routeKind,
    jumpHops,
    source,
    line,
    ...(unsupported === undefined ? {} : { unsupported }),
  };
}

export function readProofAliases(bytes: Uint8Array): PickerProofAliasList {
  const entries: PickerProofAliasEntry[] = [];
  let truncated: boolean | undefined;
  let maxEntries: number | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      if (entries.length >= MAX_ALIAS_ENTRIES) return invalid();
      entries.push(readEntry(bytesValue(wire, reader)));
    } else if (field === 2) {
      if (truncated !== undefined) return invalid();
      truncated = boolValue(wire, reader);
    } else if (field === 3) {
      if (maxEntries !== undefined) return invalid();
      maxEntries = uintValue(wire, reader);
    } else reader.skip(wire);
  });
  if (
    maxEntries === undefined ||
    maxEntries < 1 ||
    maxEntries > MAX_ALIAS_ENTRIES ||
    entries.length > maxEntries
  )
    return invalid();
  return { entries, truncated: truncated ?? false, maxEntries };
}
