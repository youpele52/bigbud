import { type MobileRemoteControlScope, DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import {
  MobileRemoteControl,
  type MobileRemotePairingPublic,
  type MobileRemotePairingStatus,
  type MobileRemoteSessionRecord,
} from "../Services/MobileRemoteControl";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toError(cause: unknown, fallbackMessage: string): Error {
  if (cause instanceof Error) {
    return cause;
  }
  return new Error(fallbackMessage, { cause });
}

const PairingRecord = Schema.Struct({
  pairingId: Schema.String,
  secret: Schema.String,
  scope: Schema.Literals(["read-only", "approve-only", "thread-control"] as const),
  baseUrl: Schema.String,
  backendBaseUrl: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  exchangedAt: Schema.NullOr(Schema.String),
});
type PairingRecord = typeof PairingRecord.Type;

const SessionRecord = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.String,
  scope: Schema.Literals(["read-only", "approve-only", "thread-control"] as const),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  label: Schema.String,
});
type SessionRecord = typeof SessionRecord.Type;

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(timestamp: string, ms: number): string {
  return new Date(Date.parse(timestamp) + ms).toISOString();
}

function isExpired(expiresAt: string): boolean {
  return Date.parse(expiresAt) <= Date.now();
}

function toSessionRecord(record: SessionRecord): MobileRemoteSessionRecord {
  return {
    sessionId: record.sessionId,
    token: record.token,
    scope: record.scope,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    label: record.label,
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const makeMobileRemoteControl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const mobileRoot = path.join(config.stateDir, "mobile-remote");
  const pairingsDir = path.join(mobileRoot, "pairings");
  const sessionsDir = path.join(mobileRoot, "sessions");

  const ensureDirectories = Effect.all(
    [
      fs.makeDirectory(pairingsDir, { recursive: true }),
      fs.makeDirectory(sessionsDir, { recursive: true }),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.asVoid);

  const decodePairingRecord = Schema.decodeUnknownSync(PairingRecord as never) as (
    value: unknown,
  ) => PairingRecord;
  const decodeSessionRecord = Schema.decodeUnknownSync(SessionRecord as never) as (
    value: unknown,
  ) => SessionRecord;

  const readJsonFile = <A>(filePath: string, decode: (value: unknown) => A) =>
    fs.readFileString(filePath).pipe(
      Effect.flatMap((raw) =>
        Effect.try({
          try: () => Option.some(decode(JSON.parse(raw))),
          catch: () => Option.none<A>(),
        }),
      ),
      Effect.catch(() => Effect.succeed(Option.none<A>())),
    );

  const writeJsonFile = (filePath: string, value: unknown) =>
    fs.writeFileString(filePath, `${JSON.stringify(value, null, 2)}\n`);

  const pairingFilePath = (pairingId: string) => path.join(pairingsDir, `${pairingId}.json`);
  const sessionFilePath = (sessionId: string) => path.join(sessionsDir, `${sessionId}.json`);

  const mobileEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.mobileRemoteControl.enabled),
    Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS.mobileRemoteControl.enabled)),
  );

  const cleanupExpired = Effect.gen(function* () {
    const pairingEntries = yield* fs
      .readDirectory(pairingsDir)
      .pipe(Effect.orElseSucceed(() => []));
    for (const entry of pairingEntries) {
      const record = yield* readJsonFile(path.join(pairingsDir, entry), decodePairingRecord);
      if (Option.isSome(record) && isExpired(record.value.expiresAt)) {
        yield* fs.remove(path.join(pairingsDir, entry), { force: true }).pipe(Effect.ignore);
      }
    }

    const sessionEntries = yield* fs
      .readDirectory(sessionsDir)
      .pipe(Effect.orElseSucceed(() => []));
    for (const entry of sessionEntries) {
      const record = yield* readJsonFile(path.join(sessionsDir, entry), decodeSessionRecord);
      if (
        Option.isSome(record) &&
        (record.value.revokedAt !== null || isExpired(record.value.expiresAt))
      ) {
        yield* fs.remove(path.join(sessionsDir, entry), { force: true }).pipe(Effect.ignore);
      }
    }
  });

  const listSessions = Effect.gen(function* () {
    yield* ensureDirectories;
    yield* cleanupExpired;
    const entries = yield* fs.readDirectory(sessionsDir).pipe(Effect.orElseSucceed(() => []));
    const sessions: MobileRemoteSessionRecord[] = [];
    for (const entry of entries) {
      const record = yield* readJsonFile(path.join(sessionsDir, entry), decodeSessionRecord);
      if (Option.isSome(record)) {
        sessions.push(toSessionRecord(record.value));
      }
    }
    sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sessions;
  });

  return {
    createPairing: (input: {
      readonly scope: MobileRemoteControlScope;
      readonly baseUrl: string;
      readonly backendBaseUrl: string;
    }) =>
      Effect.gen(function* () {
        yield* ensureDirectories;
        if (!(yield* mobileEnabled)) {
          return yield* Effect.fail(new Error("Mobile remote control is disabled."));
        }
        const createdAt = nowIso();
        const pairingId = crypto.randomUUID();
        const secret = crypto.randomUUID();
        const baseUrl = stripTrailingSlash(input.baseUrl.trim());
        const backendBaseUrl = stripTrailingSlash(input.backendBaseUrl.trim());
        const record: PairingRecord = {
          pairingId,
          secret,
          scope: input.scope,
          baseUrl,
          backendBaseUrl,
          createdAt,
          expiresAt: addMs(createdAt, PAIRING_TTL_MS),
          exchangedAt: null,
        };
        yield* writeJsonFile(pairingFilePath(pairingId), record);

        const pairUrl = `${baseUrl}/mobile/pair/${pairingId}?backend=${encodeURIComponent(backendBaseUrl)}#secret=${encodeURIComponent(secret)}`;
        return {
          pairingId,
          scope: record.scope,
          expiresAt: record.expiresAt,
          pairUrl,
          secret,
        } satisfies MobileRemotePairingPublic;
      }).pipe(Effect.mapError((cause) => toError(cause, "Failed to create mobile pairing."))),
    getPairingStatus: (pairingId: string) =>
      Effect.gen(function* () {
        yield* ensureDirectories;
        const record = yield* readJsonFile(pairingFilePath(pairingId), decodePairingRecord);
        if (Option.isNone(record)) {
          return null;
        }
        const enabled = yield* mobileEnabled;
        const available =
          enabled && record.value.exchangedAt === null && !isExpired(record.value.expiresAt);
        return {
          pairingId: record.value.pairingId,
          scope: record.value.scope,
          expiresAt: record.value.expiresAt,
          enabled,
          available,
        } satisfies MobileRemotePairingStatus;
      }).pipe(Effect.mapError((cause) => toError(cause, "Failed to read mobile pairing status."))),
    exchangePairing: (input: {
      readonly pairingId: string;
      readonly secret: string;
      readonly label: string;
    }) =>
      Effect.gen(function* () {
        yield* ensureDirectories;
        if (!(yield* mobileEnabled)) {
          return yield* Effect.fail(new Error("Mobile remote control is disabled."));
        }
        const record = yield* readJsonFile(pairingFilePath(input.pairingId), decodePairingRecord);
        if (Option.isNone(record)) {
          return yield* Effect.fail(new Error("Pairing was not found."));
        }
        if (record.value.secret !== input.secret || record.value.exchangedAt !== null) {
          return yield* Effect.fail(new Error("Pairing is no longer valid."));
        }
        if (isExpired(record.value.expiresAt)) {
          return yield* Effect.fail(new Error("Pairing expired."));
        }

        const createdAt = nowIso();
        const sessionId = crypto.randomUUID();
        const token = crypto.randomUUID();
        const session: SessionRecord = {
          sessionId,
          token,
          scope: record.value.scope,
          createdAt,
          expiresAt: addMs(createdAt, SESSION_TTL_MS),
          lastUsedAt: null,
          revokedAt: null,
          label: input.label.trim(),
        };
        yield* writeJsonFile(sessionFilePath(sessionId), session);
        yield* writeJsonFile(pairingFilePath(input.pairingId), {
          ...record.value,
          exchangedAt: createdAt,
        } satisfies PairingRecord);
        return toSessionRecord(session);
      }).pipe(Effect.mapError((cause) => toError(cause, "Failed to exchange mobile pairing."))),
    listSessions: listSessions.pipe(
      Effect.mapError((cause) => toError(cause, "Failed to list mobile sessions.")),
    ),
    revokeSession: (sessionId: string) =>
      Effect.gen(function* () {
        yield* ensureDirectories;
        const record = yield* readJsonFile(sessionFilePath(sessionId), decodeSessionRecord);
        if (Option.isNone(record)) {
          return;
        }
        yield* writeJsonFile(sessionFilePath(sessionId), {
          ...record.value,
          revokedAt: nowIso(),
        } satisfies SessionRecord);
      }).pipe(Effect.mapError((cause) => toError(cause, "Failed to revoke mobile session."))),
    validateSessionToken: (token: string) =>
      Effect.gen(function* () {
        yield* ensureDirectories;
        yield* cleanupExpired;
        if (!(yield* mobileEnabled)) {
          return null;
        }
        const entries = yield* fs.readDirectory(sessionsDir).pipe(Effect.orElseSucceed(() => []));
        for (const entry of entries) {
          const record = yield* readJsonFile(path.join(sessionsDir, entry), decodeSessionRecord);
          if (
            Option.isSome(record) &&
            record.value.token === token &&
            record.value.revokedAt === null &&
            !isExpired(record.value.expiresAt)
          ) {
            const nextRecord = {
              ...record.value,
              lastUsedAt: nowIso(),
            } satisfies SessionRecord;
            yield* writeJsonFile(path.join(sessionsDir, entry), nextRecord);
            return toSessionRecord(nextRecord);
          }
        }
        return null;
      }).pipe(
        Effect.mapError((cause) => toError(cause, "Failed to validate mobile session token.")),
      ),
  };
});

export const MobileRemoteControlLive = Layer.effect(MobileRemoteControl, makeMobileRemoteControl);
