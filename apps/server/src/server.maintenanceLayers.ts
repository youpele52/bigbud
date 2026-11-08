/**
 * Background maintenance for the server, on the shared SQLite worker: event-log compaction and
 * ledger pruning, attachment maintenance, and database compaction (the confirmed one-time
 * rebuild plus its steady-state step).
 *
 * One scheduler drives all of them (`EventLogMaintenanceSchedulerLive`), so they share the load
 * backoff and guaranteed progress. Order matters: `DatabaseCompactionLive` reads event-log
 * maintenance progress, and the scheduler picks up both optional services, so each layer is
 * provided below the ones that read it.
 *
 * @module server.maintenanceLayers
 */
import { Layer } from "effect";

import { AttachmentMaintenanceLive } from "./attachments/Layers/AttachmentMaintenance.ts";
import { DatabaseCompactionLive } from "./persistence/Layers/DatabaseCompaction.ts";
import {
  EventLogMaintenanceLive,
  EventLogMaintenanceSchedulerLive,
} from "./persistence/Layers/EventLogMaintenance.ts";

export const BackgroundMaintenanceLayerLive = EventLogMaintenanceSchedulerLive.pipe(
  Layer.provideMerge(DatabaseCompactionLive),
  Layer.provideMerge(AttachmentMaintenanceLive),
  Layer.provideMerge(EventLogMaintenanceLive),
);
