import {
  useDatabaseCompactionRunPolling,
  useDatabaseCompactionRunState,
} from "./DatabaseCompaction.runState";
import { DatabaseCompactionOverlay } from "./DatabaseCompactionOverlay";

/**
 * Mounted once at the app root: tracks the database rebuild and covers the whole app while it
 * runs, whichever screen is open, including after a reload mid-run.
 */
export function DatabaseCompactionCoordinator() {
  useDatabaseCompactionRunPolling();
  const { status, reconnecting } = useDatabaseCompactionRunState();
  if (status?.state !== "running") return null;
  return <DatabaseCompactionOverlay status={status} reconnecting={reconnecting} />;
}
