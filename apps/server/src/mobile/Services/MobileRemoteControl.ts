import { type MobileRemoteControlScope } from "@bigbud/contracts/server/mobile";
import { Effect, ServiceMap } from "effect";

export interface MobileRemotePairingPublic {
  readonly pairingId: string;
  readonly scope: MobileRemoteControlScope;
  readonly expiresAt: string;
  readonly pairUrl: string;
  readonly secret: string;
}

export interface MobileRemotePairingStatus {
  readonly pairingId: string;
  readonly scope: MobileRemoteControlScope;
  readonly expiresAt: string;
  readonly enabled: boolean;
  readonly available: boolean;
}

export interface MobileRemoteSessionRecord {
  readonly sessionId: string;
  readonly token: string;
  readonly scope: MobileRemoteControlScope;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly label: string;
}

export interface MobileRemoteControlShape {
  readonly createPairing: (input: {
    readonly scope: MobileRemoteControlScope;
    readonly baseUrl: string;
    readonly backendBaseUrl: string;
  }) => Effect.Effect<MobileRemotePairingPublic, Error>;
  readonly getPairingStatus: (
    pairingId: string,
  ) => Effect.Effect<MobileRemotePairingStatus | null, Error>;
  readonly exchangePairing: (input: {
    readonly pairingId: string;
    readonly secret: string;
    readonly label: string;
  }) => Effect.Effect<MobileRemoteSessionRecord, Error>;
  readonly listSessions: Effect.Effect<ReadonlyArray<MobileRemoteSessionRecord>, Error>;
  readonly revokeSession: (sessionId: string) => Effect.Effect<void, Error>;
  readonly validateSessionToken: (
    token: string,
  ) => Effect.Effect<MobileRemoteSessionRecord | null, Error>;
}

export class MobileRemoteControl extends ServiceMap.Service<
  MobileRemoteControl,
  MobileRemoteControlShape
>()("bigbud/mobile/Services/MobileRemoteControl") {}
