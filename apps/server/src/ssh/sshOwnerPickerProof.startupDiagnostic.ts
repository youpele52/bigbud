import type { Readable } from "node:stream";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

// Wire vocabulary from ssh_owner/config/{startup,diagnostic,source}.rs.
const MAX_RECORD_BYTES = 512; // Includes the terminating LF.
const MAX_CONFIG_BYTES = 256 * 1024;
const EVENT = "ssh_owner_alias_policy_rejected";
const CODE = "config_unsupported";
const RETIREMENT_EVENT = "ssh_owner_retirement_refused";
const RETIREMENT_CODE = "owner_retirement_unverified";
const NO_LOCATION_REMEDY =
  "Check the selected owner-private fixture config and its required settings.";
const DEFAULT_REMEDY =
  "Correct the directive to a supported value or exclude it from the selected host.";
const NO_PROXY_REMEDY = "Use a direct fixture route with no proxy.";

const remedies = {
  unknown:
    "Check the directive name and syntax at this line; remove it from the selected host if unsupported.",
  Host: "Use supported Host patterns (literal names or paths, * or ?, and optional !).",
  Match:
    "Use supported host or user criteria. Match localuser needs a trusted initiating account; exec and final are not supported.",
  Include:
    "Use a readable, owner-private Include within the selected config root and check for cycles.",
  SendEnv: "Send only LANG, LC_*, COLORTERM or NO_COLOR, or remove the SendEnv line for this host.",
  HostName: "Use a numeric IPv4 or IPv6 loopback destination.",
  Port: "Use a decimal port from 1 to 65535.",
  User: "Use a nonempty user name of at most 64 letters, digits, dots, underscores or hyphens, not starting with a hyphen.",
  HostKeyAlias: DEFAULT_REMEDY,
  UserKnownHostsFile:
    "Use owner-private user trust files (approval writes only to the first), or use none with scoped global pins for read-only trust.",
  HashKnownHosts: DEFAULT_REMEDY,
  IdentityFile:
    "Use an allowed number of distinct, owner-private identity files within the user config scope.",
  ConnectTimeout: DEFAULT_REMEDY,
  ServerAliveInterval: DEFAULT_REMEDY,
  ServerAliveCountMax: DEFAULT_REMEDY,
  AddressFamily: DEFAULT_REMEDY,
  BatchMode: DEFAULT_REMEDY,
  ClearAllForwardings: DEFAULT_REMEDY,
  IdentitiesOnly: DEFAULT_REMEDY,
  PubkeyAuthentication: DEFAULT_REMEDY,
  StrictHostKeyChecking:
    "Set StrictHostKeyChecking to yes; verify and approve the host key separately.",
  AddKeysToAgent: DEFAULT_REMEDY,
  CanonicalizeHostname: DEFAULT_REMEDY,
  CheckHostIP: DEFAULT_REMEDY,
  ControlMaster: DEFAULT_REMEDY,
  ControlPersist: DEFAULT_REMEDY,
  ForwardAgent: DEFAULT_REMEDY,
  ForwardX11: DEFAULT_REMEDY,
  ForwardX11Trusted: DEFAULT_REMEDY,
  GSSAPIAuthentication:
    "GSSAPI authentication is not supported. Add GSSAPIAuthentication no for this host.",
  HostbasedAuthentication: DEFAULT_REMEDY,
  KbdInteractiveAuthentication: DEFAULT_REMEDY,
  PasswordAuthentication: DEFAULT_REMEDY,
  PermitLocalCommand: DEFAULT_REMEDY,
  ProxyUseFdpass: DEFAULT_REMEDY,
  RequestTTY: DEFAULT_REMEDY,
  UpdateHostKeys: DEFAULT_REMEDY,
  VerifyHostKeyDNS: DEFAULT_REMEDY,
  CertificateFile: DEFAULT_REMEDY,
  ControlPath: DEFAULT_REMEDY,
  GlobalKnownHostsFile:
    "Use literal paths to separate, owner-private known-hosts files within a selected fixture scope, or use none.",
  IdentityAgent:
    "Use none or a protected Unix socket within the selected user fixture; ambient agents are not supported.",
  KnownHostsCommand: DEFAULT_REMEDY,
  ProxyCommand:
    "Use ProxyCommand nc %h %p (or a qualified absolute nc with exactly %h %p), or a direct route.",
  ProxyJump: NO_PROXY_REMEDY,
  RemoteCommand: DEFAULT_REMEDY,
  HostKeyAlgorithms: DEFAULT_REMEDY,
  PubkeyAcceptedAlgorithms: DEFAULT_REMEDY,
  PreferredAuthentications: DEFAULT_REMEDY,
  DynamicForward: DEFAULT_REMEDY,
  IgnoreUnknown: DEFAULT_REMEDY,
  LocalCommand: DEFAULT_REMEDY,
  LocalForward: DEFAULT_REMEDY,
  PKCS11Provider: DEFAULT_REMEDY,
  RemoteForward: DEFAULT_REMEDY,
  SecurityKeyProvider: DEFAULT_REMEDY,
  SetEnv: DEFAULT_REMEDY,
  // U17: inert under the owner's `-F /dev/null` launch (owner `config::is_inert`).
  UseKeychain: DEFAULT_REMEDY,
  TCPKeepAlive: DEFAULT_REMEDY,
  Compression: DEFAULT_REMEDY,
  LogLevel: DEFAULT_REMEDY,
  VisualHostKey: DEFAULT_REMEDY,
  EscapeChar: DEFAULT_REMEDY,
  IPQoS: DEFAULT_REMEDY,
  ConnectionAttempts: DEFAULT_REMEDY,
  FingerprintHash: DEFAULT_REMEDY,
  NumberOfPasswordPrompts: DEFAULT_REMEDY,
} as const;
const sources = ["user_config", "user_include", "system_config", "system_include"] as const;
type Directive = keyof typeof remedies;
type Source = (typeof sources)[number];

export interface PickerProofStartupConfigDiagnostic {
  readonly event: typeof EVENT;
  readonly version: 1;
  readonly code: typeof CODE;
  readonly location: {
    readonly directive: Directive;
    readonly source: Source;
    readonly line: number;
    readonly hop?: number;
  } | null;
  readonly remedy: (typeof remedies)[Directive] | typeof NO_LOCATION_REMEDY;
}

export class PickerProofStartupConfigError extends PickerProofOwnerError {
  constructor(readonly diagnostic: PickerProofStartupConfigDiagnostic) {
    super("configUnsupported");
    const where = diagnostic.location;
    const operand = where?.hop === undefined ? where?.directive : `ProxyJump hop ${where.hop}`;
    this.message = where
      ? `SSH owner rejected ${operand} in ${where.source.replace("_", " ")} at line ${where.line}. ${diagnostic.remedy}`
      : `SSH owner rejected the selected configuration. ${diagnostic.remedy}`;
  }
}

export class PickerProofStartupRetirementError extends PickerProofOwnerError {
  constructor(readonly remedy: string) {
    super("ownerRetirementUnverified");
    this.message = remedy;
  }
}

/** The bounded production handshake expired; the child has been killed. */
export class PickerProofStartupTimeoutError extends PickerProofOwnerError {
  constructor(readonly deadlineMs: number) {
    super("ownerUnavailable");
    this.message = `The SSH owner did not complete its startup handshake within ${deadlineMs} ms.`;
  }
}

function isDirective(value: unknown): value is Directive {
  return typeof value === "string" && Object.hasOwn(remedies, value);
}

/** The displayed remedy for a directive, or the generic unknown-keyword remedy. */
export function sshConfigDirectiveRemedy(directive: string): string {
  const canonical = canonicalSshConfigDirective(directive);
  return canonical ? remedies[canonical] : remedies.unknown;
}

const CANONICAL_DIRECTIVES = new Map(
  (Object.keys(remedies) as Directive[]).map((name) => [name.toLowerCase(), name]),
);

/** Resolve a lowercase config keyword to its canonical remedy-table name. */
export function canonicalSshConfigDirective(directive: string): Directive | undefined {
  return CANONICAL_DIRECTIVES.get(directive.toLowerCase());
}

/** True for a directive in the shared native/backend remedy table. */
export function isSshConfigDirective(directive: string): boolean {
  return canonicalSshConfigDirective(directive) !== undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(bytes: Uint8Array): PickerProofStartupConfigDiagnostic | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return;
  }
  if (
    !isObject(value) ||
    Object.keys(value).length !== 5 ||
    value.event !== EVENT ||
    value.version !== 1 ||
    value.code !== CODE
  ) {
    return;
  }
  const fields = { event: EVENT, version: 1, code: CODE } as const;
  const { location } = value;
  // Keep the v1 shape and bounded scanner, but never forward native message
  // text. Independent versions can change their prose without dropping the
  // diagnostic or allowing untrusted text into the error displayed by the UI.
  if (typeof value.remedy !== "string") return;
  if (location === null) {
    return { ...fields, location, remedy: NO_LOCATION_REMEDY };
  }
  if (!isObject(location)) return;
  const { directive, source, line, hop } = location;
  const hasHop = Object.hasOwn(location, "hop");
  if (
    Object.keys(location).length !== (hasHop ? 4 : 3) ||
    (hasHop &&
      (directive !== "ProxyJump" ||
        typeof hop !== "number" ||
        !Number.isInteger(hop) ||
        hop < 1 ||
        hop > 5))
  )
    return;
  const sourceId = sources.find((candidate) => candidate === source);
  if (
    !isDirective(directive) ||
    sourceId === undefined ||
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    line < 1 ||
    line > MAX_CONFIG_BYTES
  ) {
    return;
  }
  return {
    ...fields,
    location: { directive, source: sourceId, line, ...(typeof hop === "number" ? { hop } : {}) },
    remedy: remedies[directive],
  };
}

/** Retain at most one validated record; stderr always drains without logging. */
export function readPickerProofStartupConfigDiagnostic(stderr: Readable) {
  let line: Buffer | undefined = Buffer.alloc(MAX_RECORD_BYTES - 1);
  let length = 0;
  let oversized = false;
  let diagnostic: PickerProofStartupConfigDiagnostic | undefined;
  let retirement: string | undefined;

  stderr.on("error", () => {});
  stderr.on("data", (chunk: Buffer) => {
    let offset = 0;
    while (line && offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const size = end - offset;
      if (length + size > line.length) oversized = true;
      if (!oversized) {
        chunk.copy(line, length, offset, end);
        length += size;
      }
      if (newline === -1) return;
      if (!oversized && length > 0) {
        const bytes = line.subarray(0, length);
        diagnostic = parseRecord(bytes);
        if (diagnostic) line = undefined;
        else {
          retirement = parseRetirementRecord(bytes);
          if (retirement) line = undefined;
        }
      }
      length = 0;
      oversized = false;
      offset = end + 1;
    }
  });

  return {
    startupConfigDiagnostic: () => diagnostic,
    startupRetirementDiagnostic: () => retirement,
    sealStartupConfigDiagnostic() {
      line = undefined;
      diagnostic = undefined;
      retirement = undefined;
    },
  };
}

function parseRetirementRecord(bytes: Uint8Array): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return;
  }
  if (
    !isObject(value) ||
    Object.keys(value).length !== 4 ||
    value.event !== RETIREMENT_EVENT ||
    value.version !== 1 ||
    value.code !== RETIREMENT_CODE ||
    typeof value.remedy !== "string" ||
    value.remedy.length === 0 ||
    value.remedy.length > 512
  ) {
    return;
  }
  return value.remedy;
}
