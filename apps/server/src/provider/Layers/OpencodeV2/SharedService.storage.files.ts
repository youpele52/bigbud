/** Select only a unique open database with an open SQLite WAL/SHM companion, regardless of extension. */
export function selectV2SharedDatabase(files: readonly string[]): string {
  const names = new Set(files);
  const candidates = [...names].filter(
    (name) => names.has(`${name}-wal`) || names.has(`${name}-shm`),
  );
  if (candidates.length !== 1) throw new Error("Ambiguous native SQLite handles.");
  return candidates[0]!;
}
