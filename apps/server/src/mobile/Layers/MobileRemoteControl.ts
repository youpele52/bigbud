import { randomUUID } from "node:crypto";

import { type MobileRemoteControlScope, DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Option, Path, PubSub, Semaphore } from "effect";

import { ServerConfig } from "../../startup/config";
import { ServerSettingsService } from "../../ws/serverSettings";
import {
  MobileRemoteControl,
  type MobileRemotePairingPublic,
  type MobileRemotePairingStatus,
  type MobileRemoteSessionRecord,
} from "../Services/MobileRemoteControl";
import {
  decodePairingRecord,
  decodeSessionRecord,
  toSessionRecord,
  type PairingRecord,
  type SessionRecord,
} from "./MobileRemoteControl.records.ts";
import {
  currentMobileRecordAdmission,
  mobileRecordAdmissionFields,
  matchesMobileRecordAdmission,
} from "./MobileRemoteControl.admission.ts";
import { makeWatchSessionEnd } from "./MobileRemoteControl.sessionWatch";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toError(cause: unknown, fallbackMessage: string): Error {
  if (cause instanceof Error) {
    return cause;
  }
  return new Error(fallbackMessage, { cause });
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(timestamp: string, ms: number): string {
  return new Date(Date.parse(timestamp) + ms).toISOString();
}

function isExpired(expiresAt: string): boolean {
  return Date.parse(expiresAt) <= Date.now();
}

/** Record files only; skips in-progress `*.tmp-*` writes. */
function isRecordFileName(entry: string): boolean {
  return entry.endsWith(".json");
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function buildMobilePairUrl(input: {
  readonly baseUrl: string;
  readonly pairingId: string;
  readonly backendBaseUrl: string;
  readonly secret: string;
}): string {
  const pairBaseUrl = input.baseUrl.replace(/\/mobile\/?$/, "");
  return `${pairBaseUrl}/mobile/pair/${input.pairingId}?backend=${encodeURIComponent(input.backendBaseUrl)}#secret=${encodeURIComponent(input.secret)}`;
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

  // Revocations are user actions (rare); every open session socket waits here.
  const revocations = yield* PubSub.unbounded<string>();
  // Sessions revoked by this process. Cleanup may delete a revoked record
  // before a socket's watcher reads it, so the file alone cannot prove a
  // revocation. Revocations are rare user actions, so the set stays small.
  const revokedSessionIds = new Set<string>();

  // Every read-modify-write of pairing and session files runs under this lock,
  // so a token validation stamping `lastUsedAt` cannot overwrite a concurrent
  // revocation (or resurrect a removed session), and one pairing secret
  // cannot be exchanged twice. Mobile sessions are few; holds are short.
  const storeLock = yield* Semaphore.make(1);
  const exclusive = storeLock.withPermits(1);

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

  // Write-then-rename, so a concurrent reader never sees a truncated record
  // (which would look like a missing or revoked session).
  const writeJsonFile = (filePath: string, value: unknown) => {
    const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
    return fs
      .writeFileString(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
      .pipe(Effect.andThen(fs.rename(temporaryPath, filePath)));
  };

  const pairingFilePath = (pairingId: string) => path.join(pairingsDir, `${pairingId}.json`);
  const sessionFilePath = (sessionId: string) => path.join(sessionsDir, `${sessionId}.json`);

  const mobileEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.mobileRemoteControl.enabled),
    Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS.mobileRemoteControl.enabled)),
  );

  const cleanupExpired = Effect.gen(function* () {
    const pairingEntries = yield* fs.readDirectory(pairingsDir).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((entries) => entries.filter(isRecordFileName)),
    );
    for (const entry of pairingEntries) {
      const record = yield* readJsonFile(path.join(pairingsDir, entry), decodePairingRecord);
      if (Option.isSome(record) && isExpired(record.value.expiresAt)) {
        yield* fs.remove(path.join(pairingsDir, entry), { force: true }).pipe(Effect.ignore);
      }
    }

    const sessionEntries = yield* fs.readDirectory(sessionsDir).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((entries) => entries.filter(isRecordFileName)),
    );
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

  // Expired-record cleanup scans both directories, so it runs at most once a
  // minute rather than on every validated command.
  const CLEANUP_INTERVAL_MS = 60_000;
  let lastCleanupAtMs = Number.NEGATIVE_INFINITY;
  const cleanupExpiredThrottled = Effect.suspend(() => {
    const nowMs = Date.now();
    if (nowMs - lastCleanupAtMs < CLEANUP_INTERVAL_MS) return Effect.void;
    lastCleanupAtMs = nowMs;
    return cleanupExpired;
  });

  const listSessions = Effect.gen(function* () {
    yield* ensureDirectories;
    yield* cleanupExpired;
    const entries = yield* fs.readDirectory(sessionsDir).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((entries) => entries.filter(isRecordFileName)),
    );
    const sessions: MobileRemoteSessionRecord[] = [];
    for (const entry of entries) {
      const record = yield* readJsonFile(path.join(sessionsDir, entry), decodeSessionRecord);
      if (Option.isSome(record)) {
        sessions.push(toSessionRecord(record.value));
      }
    }
    sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return sessions;
  }).pipe(exclusive);

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
        const admission = yield* currentMobileRecordAdmission;
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
          ...mobileRecordAdmissionFields(admission),
        };
        yield* writeJsonFile(pairingFilePath(pairingId), record);

        const pairUrl = buildMobilePairUrl({
          baseUrl,
          pairingId,
          backendBaseUrl,
          secret,
        });
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
        const admission = yield* currentMobileRecordAdmission;
        if (Option.isNone(record) || !matchesMobileRecordAdmission(record.value, admission)) {
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
        const admission = yield* currentMobileRecordAdmission;
        if (Option.isNone(record) || !matchesMobileRecordAdmission(record.value, admission)) {
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
          ...mobileRecordAdmissionFields(admission),
        };
        yield* writeJsonFile(sessionFilePath(sessionId), session);
        yield* writeJsonFile(pairingFilePath(input.pairingId), {
          ...record.value,
          exchangedAt: createdAt,
        } satisfies PairingRecord);
        return toSessionRecord(session);
      }).pipe(
        exclusive,
        Effect.mapError((cause) => toError(cause, "Failed to exchange mobile pairing.")),
      ),
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
        revokedSessionIds.add(sessionId);
        yield* PubSub.publish(revocations, sessionId);
      }).pipe(
        exclusive,
        Effect.mapError((cause) => toError(cause, "Failed to revoke mobile session.")),
      ),
    watchSessionEnd: makeWatchSessionEnd({
      revocations,
      serverSettings,
      wasRevoked: (sessionId) => revokedSessionIds.has(sessionId),
      readRevokedAt: (sessionId) =>
        readJsonFile(sessionFilePath(sessionId), decodeSessionRecord).pipe(
          Effect.map(Option.map((record) => record.revokedAt)),
        ),
    }),
    validateSessionToken: (token: string) =>
      Effect.gen(function* () {
        yield* ensureDirectories;
        yield* cleanupExpiredThrottled;
        if (!(yield* mobileEnabled)) {
          return null;
        }
        const entries = yield* fs.readDirectory(sessionsDir).pipe(
          Effect.orElseSucceed(() => []),
          Effect.map((entries) => entries.filter(isRecordFileName)),
        );
        const admission = yield* currentMobileRecordAdmission;
        for (const entry of entries) {
          const record = yield* readJsonFile(path.join(sessionsDir, entry), decodeSessionRecord);
          if (
            Option.isSome(record) &&
            record.value.token === token &&
            matchesMobileRecordAdmission(record.value, admission) &&
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
        exclusive,
        Effect.mapError((cause) => toError(cause, "Failed to validate mobile session token.")),
      ),
  };
});

export const MobileRemoteControlLive = Layer.effect(MobileRemoteControl, makeMobileRemoteControl);
