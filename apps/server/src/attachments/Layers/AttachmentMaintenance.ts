/**
 * AttachmentMaintenanceLive - bounded ownership backfill and orphan sweep for the managed
 * attachments directory. See `Services/AttachmentMaintenance.ts` for the contract.
 *
 * A tick, in order: restore re-referenced trash and delete expired trash, move old orphans to
 * the trash, remove old upload staging directories, then backfill legacy ownership. The root
 * listing is reused while the root is unchanged (`AttachmentMaintenance.listing`). It stops at
 * the first file boundary past its time budget, never runs twice at once, and keeps only in-memory cursors: after a restart it starts
 * a fresh pass, which is safe because every step re-reads the filesystem and the database.
 *
 * @module AttachmentMaintenanceLive
 */
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../startup/config.ts";
import { ATTACHMENT_SWEEP_FILE_LIMIT } from "../attachmentMaintenance.layout.ts";
import {
  AttachmentMaintenance,
  AttachmentMaintenanceError,
  type AttachmentMaintenanceShape,
  type AttachmentMaintenanceTickOptions,
  type AttachmentMaintenanceTickResult,
} from "../Services/AttachmentMaintenance.ts";
import {
  runAttachmentOwnershipBackfill,
  type AttachmentBackfillState,
} from "./AttachmentMaintenance.backfill.ts";
import type { AttachmentTickContext } from "./AttachmentMaintenance.holds.ts";
import { makeAttachmentRootLister } from "./AttachmentMaintenance.listing.ts";
import {
  runAttachmentOrphanScan,
  type AttachmentSweepState,
} from "./AttachmentMaintenance.sweep.ts";
import { runAttachmentTrashPass } from "./AttachmentMaintenance.trash.ts";
import {
  runUploadDirectorySweep,
  type UploadDirectorySweepState,
} from "./AttachmentMaintenance.uploadDirs.ts";

const DEFAULT_TICK_BUDGET_MS = 1_000;

const idleResult = (
  status: AttachmentMaintenanceTickResult["status"],
  durationMs = 0,
): AttachmentMaintenanceTickResult => ({
  status,
  backlog: 0,
  processed: 0,
  budgetExhausted: false,
  durationMs,
  backfill: { scanned: 0, recorded: 0, skipped: 0, pending: 0 },
  sweep: {
    scanned: 0,
    trashed: 0,
    deleted: 0,
    restored: 0,
    uploadDirectoriesRemoved: 0,
    held: 0,
    failed: 0,
    pending: 0,
  },
});

export const makeAttachmentMaintenance = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const root = path.resolve(config.attachmentsDir);
  const backfillState: AttachmentBackfillState = { cursor: "", passCompletedAtMs: null };
  const sweepState: AttachmentSweepState = { cursor: "" };
  const uploadDirectoryState: UploadDirectorySweepState = { cursor: "" };
  const rootLister = makeAttachmentRootLister();
  let inFlight = false;

  const tick = Effect.fn("AttachmentMaintenance.tick")(function* (
    options: AttachmentMaintenanceTickOptions,
  ) {
    const startedAt = performance.now();
    const budgetMs = options.budgetMs ?? DEFAULT_TICK_BUDGET_MS;
    let budgetExhausted = false;
    const deadlineReached = () => {
      if (!budgetExhausted && performance.now() - startedAt >= budgetMs) budgetExhausted = true;
      return budgetExhausted;
    };
    const listing = yield* Effect.tryPromise(() => rootLister.read(root));
    if (listing === "missing" || listing === "invalid") {
      if (listing === "invalid") {
        yield* Effect.logWarning("attachments root is not a real directory; skipping", { root });
      }
      return idleResult("skipped-unavailable", performance.now() - startedAt);
    }
    const context: AttachmentTickContext = {
      sql,
      root,
      nowMs: options.nowMs ?? Date.now(),
      deadlineReached,
      fileOps: { remaining: ATTACHMENT_SWEEP_FILE_LIMIT },
    };
    const trash = yield* runAttachmentTrashPass(context);
    const orphans = yield* runAttachmentOrphanScan(context, sweepState, listing.files);
    const uploadDirectories = yield* runUploadDirectorySweep(
      context,
      uploadDirectoryState,
      listing.names,
    );
    const backfill = yield* runAttachmentOwnershipBackfill({
      context,
      state: backfillState,
      filesById: listing.filesById,
    });
    const sweep = {
      scanned: orphans.scanned,
      trashed: orphans.trashed,
      deleted: trash.deleted,
      restored: trash.restored,
      uploadDirectoriesRemoved: uploadDirectories.removed,
      held: orphans.held + trash.held,
      failed: orphans.failed + trash.failed + uploadDirectories.failed,
      pending: orphans.pending + trash.pending + uploadDirectories.pending,
    };
    return {
      status: "completed",
      backlog: backfill.pending + sweep.pending,
      processed:
        backfill.recorded +
        sweep.trashed +
        sweep.deleted +
        sweep.restored +
        sweep.uploadDirectoriesRemoved,
      budgetExhausted,
      durationMs: performance.now() - startedAt,
      backfill,
      sweep,
    } satisfies AttachmentMaintenanceTickResult;
  });

  const runTick: AttachmentMaintenanceShape["runTick"] = (options = {}) =>
    Effect.suspend(() => {
      // The hard ceiling: never two ticks at once, whoever schedules them.
      if (inFlight) return Effect.succeed(idleResult("skipped-in-flight"));
      inFlight = true;
      return tick(options).pipe(
        Effect.mapError((cause) => new AttachmentMaintenanceError({ operation: "tick", cause })),
        Effect.ensuring(
          Effect.sync(() => {
            inFlight = false;
          }),
        ),
      );
    });

  return {
    runTick,
  } satisfies AttachmentMaintenanceShape;
});

export const AttachmentMaintenanceLive = Layer.effect(
  AttachmentMaintenance,
  makeAttachmentMaintenance,
);
