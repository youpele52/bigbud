import { Schema } from "effect";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const MobileRemoteControlScope = Schema.Literals([
  "read-only",
  "approve-only",
  "thread-control",
]);
export type MobileRemoteControlScope = typeof MobileRemoteControlScope.Type;

export const ServerMobileRemotePairing = Schema.Struct({
  pairingId: TrimmedNonEmptyString,
  scope: MobileRemoteControlScope,
  expiresAt: IsoDateTime,
  pairUrl: TrimmedNonEmptyString,
  secret: TrimmedNonEmptyString,
});
export type ServerMobileRemotePairing = typeof ServerMobileRemotePairing.Type;

export const ServerCreateMobileRemotePairingInput = Schema.Struct({
  scope: MobileRemoteControlScope.pipe(
    Schema.withDecodingDefault(() => "thread-control" as const satisfies MobileRemoteControlScope),
  ),
  baseUrl: TrimmedNonEmptyString,
  backendBaseUrl: TrimmedNonEmptyString,
});
export type ServerCreateMobileRemotePairingInput = typeof ServerCreateMobileRemotePairingInput.Type;

export class ServerMobileRemoteError extends Schema.TaggedErrorClass<ServerMobileRemoteError>()(
  "ServerMobileRemoteError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerMobileSessionSummary = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  scope: MobileRemoteControlScope,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  label: TrimmedNonEmptyString,
});
export type ServerMobileSessionSummary = typeof ServerMobileSessionSummary.Type;

export const ServerListMobileRemoteSessionsResult = Schema.Struct({
  sessions: Schema.Array(ServerMobileSessionSummary),
});
export type ServerListMobileRemoteSessionsResult = typeof ServerListMobileRemoteSessionsResult.Type;

export const ServerRevokeMobileRemoteSessionInput = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
});
export type ServerRevokeMobileRemoteSessionInput = typeof ServerRevokeMobileRemoteSessionInput.Type;

export const ServerMobileRemoteConfig = Schema.Struct({
  enabled: Schema.Boolean,
  hostReachable: Schema.Boolean,
  pairingBaseUrl: TrimmedNonEmptyString,
  websocketBaseUrl: TrimmedNonEmptyString,
});
export type ServerMobileRemoteConfig = typeof ServerMobileRemoteConfig.Type;

export const MobilePairingStatus = Schema.Struct({
  pairingId: TrimmedNonEmptyString,
  scope: MobileRemoteControlScope,
  expiresAt: IsoDateTime,
  enabled: Schema.Boolean,
  available: Schema.Boolean,
});
export type MobilePairingStatus = typeof MobilePairingStatus.Type;

export const MobilePairingExchangeRequest = Schema.Struct({
  secret: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(() => "mobile-device")),
});
export type MobilePairingExchangeRequest = typeof MobilePairingExchangeRequest.Type;

export const MobilePairingExchangeResponse = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  sessionToken: TrimmedNonEmptyString,
  scope: MobileRemoteControlScope,
  expiresAt: IsoDateTime,
  websocketUrl: TrimmedNonEmptyString,
});
export type MobilePairingExchangeResponse = typeof MobilePairingExchangeResponse.Type;

export const MobileThreadListItem = Schema.Struct({
  threadId: ThreadId,
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  statusLabel: TrimmedNonEmptyString,
  hasPendingApproval: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type MobileThreadListItem = typeof MobileThreadListItem.Type;
