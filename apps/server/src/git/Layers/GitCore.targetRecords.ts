/**
 * Process-wide read of bigbud SSH project records (target id + workspace root), registered
 * by the server composition where the project projection lives (U15). The production owner
 * Git binding uses it to pick the exact target and the workspace root a repository must lie in.
 *
 * @module GitCore.targetRecords
 */
export interface SshTargetRecord {
  readonly executionTargetId: string;
  readonly workspaceRoot: string | null;
}

type RecordSource = () => Promise<ReadonlyArray<SshTargetRecord>>;
let source: RecordSource | undefined;

export function registerSshTargetRecordSource(next: RecordSource): () => void {
  source = next;
  return () => {
    if (source === next) source = undefined;
  };
}

/** `undefined` when no source is registered or it cannot be read (fail closed). */
export async function readSshTargetRecords(): Promise<ReadonlyArray<SshTargetRecord> | undefined> {
  return source ? source().catch(() => undefined) : undefined;
}
