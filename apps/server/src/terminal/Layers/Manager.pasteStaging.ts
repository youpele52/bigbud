import { createHash, type Hash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  TERMINAL_PASTE_CHUNK_BYTES,
  TerminalPasteStageError,
  type TerminalPasteHost,
  type TerminalPasteStageInput,
  type TerminalPasteStageResult,
} from "@bigbud/contracts/workspace/terminal.paste.ts";
import { DEFAULT_TERMINAL_ID } from "@bigbud/contracts/workspace/terminal.ts";
import { formatBytes } from "@bigbud/shared/bytes";
import { isAbsolutePath } from "@bigbud/shared/path";
import type { TerminalManagerShape } from "../Services/Manager";
import { classifyPasteFile, randomPasteUploadId } from "./Manager.pasteStaging.names.ts";
import type { LocalPasteStore } from "./Manager.pasteStaging.local.ts";
import {
  resolvePasteTarget,
  type PasteStagingSink,
  type PasteStagingTarget,
  type RemotePasteAgentResolver,
} from "./Manager.pasteStaging.target.ts";

/** An upload with no activity for this long is aborted and its partial file removed. */
export const PASTE_UPLOAD_IDLE_MS = 2 * 60 * 1000;

type BeginInput = Extract<TerminalPasteStageInput, { op: "begin" }>;

interface Upload {
  readonly threadId: string;
  readonly terminalId: string;
  readonly generation: string | undefined;
  readonly target: PasteStagingTarget;
  readonly byteLength: number;
  readonly fileName: string;
  readonly hash: Hash;
  received: number;
  sink: PasteStagingSink | null;
  busy: boolean;
  touchedAt: number;
}

export interface TerminalPasteStagingOptions {
  readonly local: LocalPasteStore;
  readonly snapshot: TerminalManagerShape["snapshot"];
  readonly maxFileBytes: () => number;
  /** Remote staging through the session's remote agent; undefined when unavailable. */
  readonly remote: RemotePasteAgentResolver | undefined;
  readonly now?: () => number;
}

const fail = (code: TerminalPasteStageError["code"], detail: string) =>
  new TerminalPasteStageError({ code, detail });
const terminalKey = (threadId: string, terminalId: string) =>
  JSON.stringify([threadId, terminalId]);

/**
 * Server-authoritative paste staging. The machine, generation and liveness come from the terminal
 * session; a client only supplies bytes. Files are removed when their terminal closes or restarts.
 */
export function makeTerminalPasteStaging(options: TerminalPasteStagingOptions) {
  const now = options.now ?? Date.now;
  const uploads = new Map<string, Upload>();
  const staged = new Map<string, Array<{ target: PasteStagingTarget; path: string }>>();

  const guard = <A>(detail: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        Schema.is(TerminalPasteStageError)(cause)
          ? cause
          : fail(
              "storageFailed",
              `${detail}: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
    });

  const dropUpload = (id: string) => {
    const upload = uploads.get(id);
    uploads.delete(id);
    return upload?.sink
      ? guard("Discard failed", () => upload.sink!.abort()).pipe(Effect.ignore)
      : Effect.void;
  };

  const expireIdle = Effect.suspend(() =>
    Effect.forEach(
      [...uploads].filter(
        ([, upload]) => !upload.busy && now() - upload.touchedAt > PASTE_UPLOAD_IDLE_MS,
      ),
      ([id]) => dropUpload(id),
      { discard: true },
    ),
  );

  const currentSession = Effect.fn("terminal.pasteStaging.session")(function* (
    threadId: string,
    terminalId: string,
    expectedGeneration: string | undefined,
  ) {
    const snapshot = yield* options
      .snapshot({ threadId, terminalId })
      .pipe(Effect.mapError(() => fail("terminalChanged", "This terminal is no longer open.")));
    if (
      snapshot.status !== "running" ||
      (expectedGeneration !== undefined && snapshot.runtimeGeneration !== expectedGeneration)
    )
      return yield* fail(
        "terminalChanged",
        "This terminal restarted or stopped; the paste was discarded.",
      );
    return snapshot;
  });

  const begin = Effect.fn("terminal.pasteStaging.begin")(function* (input: BeginInput) {
    yield* expireIdle;
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const maxBytes = options.maxFileBytes();
    if (input.byteLength > maxBytes)
      return yield* fail(
        "tooLarge",
        `${input.fileName || "This file"} is ${formatBytes(input.byteLength)}; the paste limit is ${formatBytes(maxBytes)}. Change it in Settings › Terminal.`,
      );
    const snapshot = yield* currentSession(input.threadId, terminalId, input.expectedGeneration);
    const target = yield* resolvePasteTarget({
      executionTargetId: snapshot.executionTargetId,
      threadId: input.threadId,
      terminalId,
      generation: snapshot.runtimeGeneration,
      local: options.local,
      remote: options.remote,
    });
    const uploadId = randomPasteUploadId();
    uploads.set(uploadId, {
      threadId: input.threadId,
      terminalId,
      generation: snapshot.runtimeGeneration,
      target,
      byteLength: input.byteLength,
      fileName: input.fileName,
      hash: createHash("sha256"),
      received: 0,
      sink: null,
      busy: false,
      touchedAt: now(),
    });
    return {
      op: "begin" as const,
      uploadId,
      chunkBytes: TERMINAL_PASTE_CHUNK_BYTES,
      host: target.host satisfies TerminalPasteHost,
      hostLabel: target.hostLabel,
    };
  });

  const withUpload = <A>(
    uploadId: string,
    run: (upload: Upload) => Effect.Effect<A, TerminalPasteStageError>,
  ) =>
    Effect.gen(function* () {
      const upload = uploads.get(uploadId);
      if (!upload || upload.busy)
        return yield* fail(
          "invalidUpload",
          "This paste upload is unknown, expired or already busy.",
        );
      upload.busy = true;
      upload.touchedAt = now();
      return yield* run(upload).pipe(
        Effect.tapError(() => dropUpload(uploadId)),
        Effect.ensuring(
          Effect.sync(() => {
            upload.busy = false;
            upload.touchedAt = now();
          }),
        ),
      );
    });

  const chunk = (input: Extract<TerminalPasteStageInput, { op: "chunk" }>) =>
    withUpload(input.uploadId, (upload) =>
      Effect.gen(function* () {
        const bytes = Buffer.from(input.data, "base64");
        if (
          input.offset !== upload.received ||
          bytes.byteLength === 0 ||
          bytes.byteLength > TERMINAL_PASTE_CHUNK_BYTES ||
          upload.received + bytes.byteLength > upload.byteLength
        )
          return yield* fail(
            "invalidUpload",
            "Paste upload chunks arrived out of order or oversized.",
          );
        if (!upload.sink) {
          const kind = classifyPasteFile(bytes.subarray(0, 16), upload.fileName);
          upload.sink = yield* guard("Could not start the staged file", () =>
            upload.target.begin(kind, upload.byteLength),
          );
        }
        yield* guard("Could not write the staged file", () => upload.sink!.write(bytes));
        upload.hash.update(bytes);
        upload.received += bytes.byteLength;
        return { op: "chunk" as const, receivedBytes: upload.received };
      }),
    );

  const commit = (input: Extract<TerminalPasteStageInput, { op: "commit" }>) =>
    withUpload(input.uploadId, (upload) =>
      Effect.gen(function* () {
        const digest = upload.hash.copy().digest("hex");
        if (upload.received !== upload.byteLength || !upload.sink)
          return yield* fail("integrity", "The paste upload is incomplete.");
        if (input.sha256 !== undefined && input.sha256 !== digest)
          return yield* fail(
            "integrity",
            "The pasted file changed in transit; nothing was pasted.",
          );
        // A restart during the upload must never deliver the file to the new shell.
        yield* currentSession(upload.threadId, upload.terminalId, upload.generation);
        const committed = yield* guard("Could not finish the staged file", () =>
          upload.sink!.commit(digest),
        );
        uploads.delete(input.uploadId);
        if (!isAbsolutePath(committed.path))
          return yield* fail("storageFailed", "The staged file path is not absolute.");
        const key = terminalKey(upload.threadId, upload.terminalId);
        staged.set(key, [
          ...(staged.get(key) ?? []),
          { target: upload.target, path: committed.path },
        ]);
        return {
          op: "commit" as const,
          path: committed.path,
          host: upload.target.host,
          hostLabel: upload.target.hostLabel,
          clipboard: committed.clipboard,
        };
      }),
    );

  /** Abort in-flight uploads and delete staged files for one terminal, or a whole thread. */
  const release = (threadId: string, terminalId?: string) =>
    Effect.gen(function* () {
      const matches = (owner: { threadId: string; terminalId: string }) =>
        owner.threadId === threadId &&
        (terminalId === undefined || owner.terminalId === terminalId);
      yield* Effect.forEach(
        [...uploads].filter(([, upload]) => matches(upload)),
        ([id]) => dropUpload(id),
        { discard: true },
      );
      for (const [key, files] of staged) {
        const [ownerThread, ownerTerminal] = JSON.parse(key) as [string, string];
        if (!matches({ threadId: ownerThread, terminalId: ownerTerminal })) continue;
        staged.delete(key);
        yield* Effect.forEach(
          files,
          (file) =>
            guard("Could not remove a staged file", () => file.target.release(file.path)).pipe(
              Effect.ignore,
            ),
          { discard: true },
        );
      }
    });

  /** Releases terminals whose session ended or restarted without a close through this server. */
  const reconcile = Effect.gen(function* () {
    yield* expireIdle;
    for (const [key, files] of staged) {
      const [threadId, terminalId] = JSON.parse(key) as [string, string];
      const current = yield* options.snapshot({ threadId, terminalId }).pipe(
        Effect.map((snapshot) =>
          snapshot.status === "running" ? snapshot.runtimeGeneration : null,
        ),
        Effect.orElseSucceed(() => null),
      );
      const stale = files.filter((file) => current === null || file.target.generation !== current);
      if (stale.length === 0) continue;
      const kept = files.filter((file) => !stale.includes(file));
      if (kept.length > 0) staged.set(key, kept);
      else staged.delete(key);
      yield* Effect.forEach(
        stale,
        (file) =>
          guard("Could not remove a staged file", () => file.target.release(file.path)).pipe(
            Effect.ignore,
          ),
        { discard: true },
      );
    }
  });

  const stage = (
    input: TerminalPasteStageInput,
  ): Effect.Effect<TerminalPasteStageResult, TerminalPasteStageError> => {
    switch (input.op) {
      case "begin":
        return begin(input);
      case "chunk":
        return chunk(input);
      case "commit":
        return commit(input);
      case "abort":
        return dropUpload(input.uploadId).pipe(Effect.as({ op: "abort" as const }));
    }
  };

  return { stage, release, reconcile };
}

export type TerminalPasteStaging = ReturnType<typeof makeTerminalPasteStaging>;
