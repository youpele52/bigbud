import { assembleSnapshotRows as assembleSnapshotRowsFromSnapshot } from "./ProjectionSnapshotQueryAssembly.snapshot.ts";

export const assembleSnapshotRows = assembleSnapshotRowsFromSnapshot;
export type ProjectionSnapshotAssemblyRows = Parameters<typeof assembleSnapshotRows>[0];
