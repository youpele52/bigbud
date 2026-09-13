export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(row)
      .toSorted()
      .map((key) => [key, row[key]]),
  );
}

export function compareNormalizedRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}
