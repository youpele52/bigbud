export interface RemoteAgentIdentity {
  readonly version: string;
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly buildDigest: string;
  readonly operatingSystem: string;
  readonly architecture: string;
}

export class RemoteAgentIdentityError extends Error {
  readonly _tag = "RemoteAgentIdentityError";

  constructor(message: string) {
    super(message);
    this.name = "RemoteAgentIdentityError";
  }
}

export function parseRemoteAgentCheckOutput(stdout: string): RemoteAgentIdentity {
  const [
    name,
    version,
    protocolMajorValue,
    protocolMinorValue,
    buildDigest,
    operatingSystem,
    architecture,
    ...extra
  ] = stdout.trim().split(/\s+/);
  const protocolMajor = Number(protocolMajorValue);
  const protocolMinor = Number(protocolMinorValue);
  if (
    name !== "bigbud-remote-agent" ||
    !version ||
    !Number.isSafeInteger(protocolMajor) ||
    protocolMajor < 0 ||
    !Number.isSafeInteger(protocolMinor) ||
    protocolMinor < 0 ||
    !buildDigest ||
    !operatingSystem ||
    !architecture ||
    extra.length > 0
  ) {
    throw new RemoteAgentIdentityError("Remote agent returned invalid identity metadata.");
  }
  return {
    version,
    protocolMajor,
    protocolMinor,
    buildDigest,
    operatingSystem,
    architecture,
  };
}

export function remoteAgentIdentityMatches(
  identity: RemoteAgentIdentity,
  expected: {
    readonly version: string;
    readonly protocolMajor: number;
    readonly protocolMinor: number;
    readonly buildDigest: string;
  },
): boolean {
  return (
    identity.version === expected.version &&
    identity.protocolMajor === expected.protocolMajor &&
    identity.protocolMinor === expected.protocolMinor &&
    identity.buildDigest === expected.buildDigest
  );
}
